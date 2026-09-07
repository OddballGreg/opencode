import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

/**
 * Fill in `question` from `header` when the model omitted it.
 *
 * `question` (the prompt body) and `header` (a short tab label) render in
 * different places, so they are genuinely distinct fields -- but models very
 * often send only `header` + `options` and drop `question` entirely. Measured
 * against this instance's recorded history: 126 of 206 `question`-tool
 * argument failures were exactly this, and 125 of those 126 carried both
 * `header` and `options`. Each one discarded the call, forced a re-ask, and
 * showed the user a bare "Asked 0 questions".
 *
 * Rejecting a payload that already states the question in `header` is strictly
 * worse than rendering the header as the prompt: the intent is present and
 * unambiguous. So default `question` to `header` instead of failing.
 *
 * Runs only after a strict decode has failed, and only when `question` is
 * absent/blank while `header` is a non-empty string -- a supplied `question`
 * is never overwritten.
 */
export const repairArguments = (args: unknown): unknown => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args
  const questions = (args as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return args
  let changed = false
  const patched = questions.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry
    const record = entry as Record<string, unknown>
    const existing = record["question"]
    if (typeof existing === "string" && existing.trim().length > 0) return entry
    const header = record["header"]
    if (typeof header !== "string" || header.trim().length === 0) return entry
    changed = true
    return { ...record, question: header }
  })
  return changed ? { ...(args as Record<string, unknown>), questions: patched } : args
}

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      repairArguments,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: params.questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = params.questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            title: `Asked ${params.questions.length} question${params.questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
