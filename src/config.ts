import { z } from "zod"

/** Compaction override: the summary prompt only — the model comes from the native `agents.compaction.model` setting. */
const CompactionFlow = z.strictObject({
  /** Prompt template with a `${transcript}` placeholder for the flattened conversation. */
  prompt: z.string().min(1).optional(),
})

const Flow = z.strictObject({
  /** `provider/model` or `provider/model#variant`. Cross-provider targets are routed through OpenCode's own model router. */
  model: z.string().trim().min(1).optional(),
  /** Prompt template with `${placeholders}`. */
  prompt: z.string().min(1).optional(),
})

export const Options = z.strictObject({
  compaction: CompactionFlow.optional(),
  goal: Flow.optional(),
  btw: Flow.optional(),
})

export type Options = z.output<typeof Options>
export type Flow = z.output<typeof Flow>
