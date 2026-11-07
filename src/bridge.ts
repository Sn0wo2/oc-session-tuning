/**
 * Local answering endpoint for out-of-band model routing.
 *
 * When a classified goal-review or side-question request is retargeted to a model whose
 * provider speaks a different wire protocol, the request cannot simply be re-URLed: the
 * response is still decoded by the source protocol's driver. Instead the real model call runs
 * out-of-band through the plugin host's model resolution (native provider support, every
 * protocol), and the outbound request is replaced with one pointing at this endpoint, which
 * streams the result back as a minimal Server-Sent-Events stream in the source protocol's own
 * format. The source driver decodes a stream of its own family — no protocol translation
 * matrix, and any target model the catalog can resolve works.
 *
 * The registry hangs off `globalThis` so a server bound before a plugin hot reload keeps
 * serving entries registered by the reloaded module instance.
 */

export type BridgeFamily = "anthropic" | "chat" | "responses"

export interface BridgeEntry {
  readonly family: BridgeFamily
  readonly model: string
  readonly run: () => Promise<string>
}

interface Registry {
  server?: ReturnType<typeof Bun.serve>
  readonly entries: Map<string, BridgeEntry>
}

const HOST = globalThis as typeof globalThis & { __ocSessionTuningBridge?: Registry }

const registry = (): Registry => (HOST.__ocSessionTuningBridge ??= { entries: new Map() })

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const jsonError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } })

/** One Server-Sent-Events frame; the `event:` line is optional (chat families omit it). */
const sse = (event: string | undefined, data: unknown) =>
  `${event === undefined ? "" : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`

const approximateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4))

/** Minimal Anthropic Messages stream: text block plus start/stop and terminal usage. */
const streamAnthropic = (id: string, model: string, text: string): string => {
  const message = {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
  }
  return [
    sse("message_start", {
      type: "message_start",
      message: { ...message, usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: approximateTokens(text) },
    }),
    sse("message_stop", { type: "message_stop" }),
  ].join("")
}

/** Minimal chat-completions chunk stream. */
const streamChat = (id: string, model: string, text: string): string => {
  const chunk = (choices: unknown[]) => ({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
  })
  return [
    sse(undefined, chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }])),
    sse(undefined, chunk([{ index: 0, delta: {}, finish_reason: "stop" }])),
    "data: [DONE]\n\n",
  ].join("")
}

/** Minimal Responses-API event stream. */
const streamResponses = (id: string, model: string, text: string): string => {
  const created = Math.floor(Date.now() / 1000)
  const item = {
    id: `${id}-item-0`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }
  const usage = { input_tokens: 1, output_tokens: approximateTokens(text), total_tokens: approximateTokens(text) + 1 }
  return [
    sse(undefined, {
      type: "response.created",
      response: { id, object: "response", created_at: created, status: "in_progress", model, output: [] },
    }),
    sse(undefined, {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    sse(undefined, {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    sse(undefined, {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    sse(undefined, {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    }),
    sse(undefined, {
      type: "response.content_part.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }),
    sse(undefined, { type: "response.output_item.done", output_index: 0, item }),
    sse(undefined, {
      type: "response.completed",
      response: { id, object: "response", created_at: created, status: "completed", model, output: [item], usage },
    }),
  ].join("")
}

const streams: Record<BridgeFamily, (id: string, model: string, text: string) => string> = {
  anthropic: streamAnthropic,
  chat: streamChat,
  responses: streamResponses,
}

const handle = async (request: Request): Promise<Response> => {
  const url = new URL(request.url)
  if (!url.pathname.startsWith("/bridge/")) return jsonError(404, "not found")
  const token = url.pathname.slice("/bridge/".length)
  const entry = registry().entries.get(token)
  if (entry === undefined) return jsonError(404, "unknown or already consumed bridge token")
  request.signal.addEventListener("abort", () => registry().entries.delete(token))
  let text: string
  try {
    text = await entry.run()
  } catch (cause) {
    registry().entries.delete(token)
    console.warn(`oc-session-tuning: bridge model call failed: ${describe(cause)}`)
    return jsonError(500, `oc-session-tuning: bridge model call failed: ${describe(cause)}`)
  }
  registry().entries.delete(token)
  return new Response(streams[entry.family](token, entry.model, text), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

/**
 * Registers an entry and returns the local URL that will stream its result in the entry's
 * family. Concurrent fetches of the same URL share one out-of-band call; the token is
 * single-use and dropped when the client aborts.
 */
export const serve = (entry: BridgeEntry): string => {
  const state = registry()
  state.server ??= Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, fetch: handle })
  const token = crypto.randomUUID()
  let pending: Promise<string> | undefined
  state.entries.set(token, {
    family: entry.family,
    model: entry.model,
    run: () => (pending ??= entry.run()),
  })
  return `http://127.0.0.1:${state.server.port}/bridge/${token}`
}
