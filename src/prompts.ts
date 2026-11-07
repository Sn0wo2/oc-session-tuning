import { isRecord } from "./util.ts"

/**
 * Sentinels embedded in replaced prompts so the HTTP layer can still classify a
 * generate request after the built-in markers are gone. HTML comments are inert to the model.
 */
export const GOAL_SENTINEL = "<!-- oc-session-tuning:goal-review -->"
export const BTW_SENTINEL = "<!-- oc-session-tuning:btw -->"

/** Built-in v2.2.5 markers: goal/judge.txt line 1 and the client /btw instructions. */
const GOAL_MARKER = "You are now the reviewer for the session"
const BTW_MARKER = "quick side question about the conversation"
const BTW_INSTRUCTION_TAIL = "Do not call any tools and do not take any actions."

const GOAL_OBJECTIVE_PATTERN = /<untrusted_objective>\n?([\s\S]*?)\n?<\/untrusted_objective>/
const GOAL_BACKGROUND_PATTERN = /<\/untrusted_objective>\s*([\s\S]*?)\s*\nReply with exactly one line/

export const isGoalJudge = (text: string) => text.includes(GOAL_MARKER) || text.includes(GOAL_SENTINEL)
export const isBtw = (text: string) => text.includes(BTW_MARKER) || text.includes(BTW_SENTINEL)

export const messageText = (message: unknown): string => {
  if (!isRecord(message)) return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n")
}

/** Rewrites the text of a user message in place; falls back to appending a text part. */
export const setMessageText = (message: unknown, text: string) => {
  if (!isRecord(message) || !Array.isArray(message.content)) return
  for (const part of message.content) {
    if (isRecord(part) && part.type === "text") {
      part.text = text
      return
    }
  }
  message.content.push({ type: "text", text })
}

export const extractGoalObjective = (text: string): string => GOAL_OBJECTIVE_PATTERN.exec(text)?.[1]?.trim() ?? ""

export const extractGoalBackground = (text: string): string => GOAL_BACKGROUND_PATTERN.exec(text)?.[1]?.trim() ?? ""

export const extractBtwQuestion = (text: string): string => {
  const index = text.indexOf(BTW_INSTRUCTION_TAIL)
  return index === -1 ? text : text.slice(index + BTW_INSTRUCTION_TAIL.length).trim()
}

/**
 * Renders the goal-review replacement. The verdict contract and the objective are always
 * present: the goal loop parses one JSON line, and without the objective the reviewer
 * cannot judge anything.
 */
export const renderGoalPrompt = (template: string, objective: string, background: string) => {
  const body = template.replaceAll("${objective}", objective).replaceAll("${background}", background)
  const blocks = [GOAL_SENTINEL, body]
  if (!body.includes("<untrusted_objective>")) {
    blocks.push(`<untrusted_objective>\n${objective}\n</untrusted_objective>`)
  }
  const contract = verdictContract(body, background)
  if (contract.length > 0) blocks.push(contract)
  return blocks.filter((block) => block.length > 0).join("\n\n")
}

export const renderBtwPrompt = (template: string, question: string) =>
  [BTW_SENTINEL, template.replaceAll("${question}", question)].join("\n\n")

export const renderCompactionPrompt = (template: string, transcript: string) =>
  template.replaceAll("${transcript}", transcript)

const verdictContract = (body: string, background: string) => {
  if (body.includes('"verdict"')) return ""
  const shapes = [
    '{"verdict":"done","reason":"<the evidence that the goal is met>"}',
    '{"verdict":"continue","reason":"<what is missing or wrong>","next_step":"<the next concrete step>"}',
    '{"verdict":"blocked","reason":"<what the assistant needs from the user, or why the goal is impossible>"}',
    '{"verdict":"paused","reason":"<what the user asked for>"}',
  ]
  // "wait" is only valid while a background shell runs; judge.txt offers it under the same condition.
  if (background.includes("Background shells still running")) {
    shapes.push('{"verdict":"wait","reason":"<the running shell whose result the goal needs>"}')
  }
  return [
    "Reply with exactly one line of JSON and nothing else, in one of these shapes:",
    ...shapes,
    "Rules:",
    "- Judge only from evidence in the conversation above: tool results, command output, and file contents. The assistant claiming the goal is met is not evidence.",
    '- "done" only when the evidence shows the whole goal is met. When in doubt, answer "continue".',
    '- "paused" when the latest user message asks to stop, pause or abandon the goal.',
    '- "blocked" only when the assistant cannot make progress without the user. Slow progress is not a blocker.',
  ].join("\n")
}
