import type { Ref as ModelRef } from "@opencode/schema/model"
import { type BridgeFamily, serve } from "./bridge.ts"
import { isBtw, isGoalJudge } from "./prompts.ts"
import { isRecord } from "./util.ts"

type FlowModels = { readonly goal?: ModelRef; readonly btw?: ModelRef }
/** Wire-protocol families of the outgoing request body. `gemini` and unknown shapes have no bridge. */
type Family = BridgeFamily | "gemini" | "other"

const warned = new Set<string>()
const warnOnce = (message: string) => {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(`oc-session-tuning: ${message}`)
}

/** Text of the parts of a wire message; every family names its text field `text`. */
const partsText = (parts: unknown): string =>
  Array.isArray(parts)
    ? parts.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
    : ""

/** Last user message across chat/Anthropic `messages`, Responses `input`, and Gemini `contents`. */
const lastUserText = (body: Record<string, unknown>): string => {
  if (Array.isArray(body.messages)) {
    for (let index = body.messages.length - 1; index >= 0; index -= 1) {
      const message = body.messages[index]
      if (!isRecord(message) || message.role !== "user") continue
      return typeof message.content === "string" ? message.content : partsText(message.content)
    }
    return ""
  }
  if (Array.isArray(body.contents)) {
    for (let index = body.contents.length - 1; index >= 0; index -= 1) {
      const message = body.contents[index]
      if (!isRecord(message) || message.role !== "user") continue
      return partsText(message.parts)
    }
    return ""
  }
  const input = body.input
  if (typeof input === "string") return input
  if (Array.isArray(input)) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
      const item = input[index]
      if (!isRecord(item) || item.role !== "user") continue
      return typeof item.content === "string" ? item.content : partsText(item.content)
    }
  }
  return ""
}

const classify = (text: string): "goal" | "btw" | undefined => {
  if (isGoalJudge(text)) return "goal"
  if (isBtw(text)) return "btw"
  return undefined
}

/**
 * The outgoing body speaks one of opencode's wire protocols: `messages` is chat completions or
 * Anthropic Messages (which carries the prompt as a top-level `system`), `input` is OpenAI
 * Responses, `contents` is Gemini.
 */
const bodyFamily = (body: Record<string, unknown>): Family => {
  if (Array.isArray(body.messages)) return body.system !== undefined ? "anthropic" : "chat"
  if (body.input !== undefined) return "responses"
  if (body.contents !== undefined) return "gemini"
  return "other"
}

const rebuild = (request: Request, url: string, body: Record<string, unknown>) =>
  new Request(url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(body),
    signal: request.signal,
  })

const description = (family: Family) => (family === "other" ? "an unrecognized" : `a ${family}`)

/**
 * Rewrites a generate-kind request so a classified goal-review or side-question call uses the
 * configured model. The plugin never touches credentials:
 *
 * - same provider: swap the body's model field (chat, Anthropic, and Responses bodies carry one);
 * - cross-provider: the real call runs through OpenCode's own model router (any protocol, native
 *   provider resolution) and the outbound request is answered locally with a stream the source
 *   driver decodes natively (see bridge.ts);
 * - otherwise: warn once and leave the request unchanged.
 */
export const rewriteGenerateRequest = async (
  event: { readonly kind: string; readonly model: { readonly providerID: string }; request: Request },
  flows: FlowModels,
  callModel: (model: ModelRef, prompt: string) => Promise<string>,
) => {
  if (event.kind !== "generate" || (!flows.goal && !flows.btw)) return
  let body: Record<string, unknown>
  try {
    const parsed: unknown = await event.request.clone().json()
    if (!isRecord(parsed)) return
    body = parsed
  } catch {
    return
  }
  const text = lastUserText(body)
  if (!text) return
  const flow = classify(text)
  const target = flow === undefined ? undefined : flows[flow]
  if (flow === undefined || target === undefined) return
  const family = bodyFamily(body)

  if (target.providerID === event.model.providerID) {
    if ((family === "anthropic" || family === "chat" || family === "responses") && typeof body.model === "string") {
      body.model = target.id
      event.request = rebuild(event.request, event.request.url, body)
    } else {
      warnOnce(
        `cannot switch the ${flow} model within ${target.providerID}: the request is ${description(family)} wire format, which carries no swappable model field; leaving the request unchanged`,
      )
    }
    return
  }

  if (family === "anthropic" || family === "chat" || family === "responses") {
    event.request = new Request(
      serve({
        family,
        model: target.id,
        run: () => callModel(target, text),
      }),
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: event.request.signal },
    )
    return
  }

  warnOnce(
    `cannot route ${flow} to ${target.providerID}/${target.id}: no bridge for ${description(family)} request wire format; leaving the request unchanged`,
  )
}
