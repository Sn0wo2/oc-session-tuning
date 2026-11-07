import { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Model } from "@opencode/schema/model"
import { type Flow, Options } from "./config.ts"
import { rewriteGenerateRequest } from "./http.ts"
import { flatten } from "./message.ts"
import {
  extractBtwQuestion,
  extractGoalBackground,
  extractGoalObjective,
  isBtw,
  isGoalJudge,
  messageText,
  renderBtwPrompt,
  renderCompactionPrompt,
  renderGoalPrompt,
  setMessageText,
} from "./prompts.ts"

type FlowTuning = { readonly model?: Model.Ref; readonly prompt?: string }

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const parseRef = (value: string, flow: string) => {
  try {
    return Model.Ref.parse(value)
  } catch (cause) {
    throw new Error(`oc-session-tuning: ${flow} model "${value}" is not a valid model reference: ${describe(cause)}`)
  }
}

const withModel = (flow: Flow | undefined, name: string): FlowTuning | undefined =>
  flow === undefined
    ? undefined
    : { model: flow.model === undefined ? undefined : parseRef(flow.model, name), prompt: flow.prompt }

export default Plugin.define({
  id: "oc-session-tuning",
  async setup(ctx) {
    const parsed = Options.safeParse(ctx.options ?? {})
    if (!parsed.success) throw new Error(`oc-session-tuning: invalid plugin options: ${parsed.error.message}`)
    const options = parsed.data
    const compaction = options.compaction
    const goal = withModel(options.goal, "goal")
    const btw = withModel(options.btw, "btw")
    const registrations: Registration[] = []

    if (compaction?.prompt !== undefined) {
      const template = compaction.prompt
      registrations.push(
        await ctx.session.hook("compaction", async (event) => {
          try {
            const transcript = flatten(event.messages)
            if (!transcript) return
            const response = await ctx.experimental.generate.text({
              model: event.model,
              prompt: renderCompactionPrompt(template, transcript),
            })
            const summary = response.text.trim()
            if (!summary) return
            event.result = { summary }
          } catch (cause) {
            console.warn(
              `oc-session-tuning: compaction override failed, using the built-in compaction: ${describe(cause)}`,
            )
          }
        }),
      )
    }

    if (goal?.prompt !== undefined || btw?.prompt !== undefined) {
      registrations.push(
        await ctx.session.hook("generate", async (event) => {
          const last = event.messages.at(-1)
          if (last === undefined || last.role !== "user") return
          const text = messageText(last)
          if (!text) return
          if (goal?.prompt !== undefined && isGoalJudge(text)) {
            setMessageText(last, renderGoalPrompt(goal.prompt, extractGoalObjective(text), extractGoalBackground(text)))
            return
          }
          if (btw?.prompt !== undefined && isBtw(text)) {
            setMessageText(last, renderBtwPrompt(btw.prompt, extractBtwQuestion(text)))
          }
        }),
      )
    }

    if (goal?.model !== undefined || btw?.model !== undefined) {
      const callModel = async (model: Model.Ref, prompt: string) => {
        const response = await ctx.experimental.generate.text({ model, prompt })
        return response.text
      }
      registrations.push(
        await ctx.session.hook("http.request", (event) =>
          rewriteGenerateRequest(event, { goal: goal?.model, btw: btw?.model }, callModel),
        ),
      )
    }

    return async () => {
      for (const registration of registrations) await registration.dispose()
    }
  },
})
