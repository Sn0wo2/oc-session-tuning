import { clip, isRecord, stringify } from "./util.ts"

const TOOL_CLIP = 1_200

/** `ToolResultValue`: `{ type: "json" | "text" | "content" | "error", value }`. */
const toolResultText = (result: unknown): string => {
  if (!isRecord(result)) return stringify(result)
  if (result.type === "text" && typeof result.value === "string") return result.value
  if (result.type === "content" && Array.isArray(result.value)) {
    return result.value
      .map((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "[file attachment]",
      )
      .join("\n")
  }
  return stringify(result.value ?? result)
}

const partText = (part: unknown): string | undefined => {
  if (!isRecord(part)) return undefined
  switch (part.type) {
    case "text":
      return typeof part.text === "string" ? part.text : undefined
    case "media": {
      const media = isRecord(part.media) ? part.media : undefined
      return `[attachment: ${typeof media?.mediaType === "string" ? media.mediaType : "file"}]`
    }
    case "tool-call": {
      const name = typeof part.name === "string" ? part.name : "tool"
      return `[tool call ${name}(${clip(stringify(part.input), TOOL_CLIP)})]`
    }
    case "tool-result": {
      const name = typeof part.name === "string" ? part.name : "tool"
      return `[${name} result]\n${clip(toolResultText(part.result), TOOL_CLIP)}`
    }
    case "compaction":
      return typeof part.text === "string" && part.text
        ? `[earlier summary]\n${clip(part.text, TOOL_CLIP * 4)}`
        : "[earlier context was compacted by the provider]"
    default:
      // Reasoning, effort markers, and unknown future parts carry nothing a summary needs.
      return undefined
  }
}

/** Flattens LLM messages into a readable transcript for a one-shot summary request. */
export const flatten = (messages: readonly unknown[]): string => {
  const blocks: string[] = []
  for (const message of messages) {
    if (!isRecord(message) || message.role === "system") continue
    const content = Array.isArray(message.content) ? message.content : []
    const parts = content.map(partText).filter((text): text is string => text !== undefined && text.trim().length > 0)
    if (parts.length === 0) continue
    const role = message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool" : "User"
    blocks.push(`${role}:\n${parts.join("\n")}`)
  }
  return blocks.join("\n\n")
}
