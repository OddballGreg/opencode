import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import * as QuestionTool from "@/tool/question"

const it = testEffect(LayerNode.compile(LayerNode.group([Truncate.node, Agent.node])))

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // The wrap ends with Effect.orDie, so the failure lives in the cause as a
      // defect. Recover the typed instance from there.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const args = error as Tool.InvalidArgumentsError
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.message).toContain(`["questions"][0]["question"]`)
    }),
  )

  // Models routinely serialize a nested argument as a JSON *string* rather than
  // the structure itself (observed on the `question` tool:
  // `{"questions": "[{\"header\":...}]"}` -> `Expected array, got "[{...}]"`).
  // The payload carries the full intent, so rejecting it costs a pointless
  // round-trip. The wrap retries once with such properties parsed.
  const questionish = Schema.Struct({
    questions: Schema.Array(Schema.Struct({ question: Schema.String, options: Schema.Array(Schema.String) })),
  })

  const defineCapturing = <P extends Schema.Struct<any>>(id: string, parameters: P, calls: unknown[]) =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        id,
        Effect.succeed({
          description: "test tool",
          parameters: parameters as any,
          execute(args: unknown) {
            calls.push(args)
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      return tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
    })

  it.effect("recovers a nested argument that the model sent as a JSON string", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineCapturing("qstring", questionish, calls)
      const questions = [{ question: "Which first?", options: ["a", "b"] }]

      const exit = yield* execute({ questions: JSON.stringify(questions) }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      // The tool receives the decoded structure, not the raw string.
      expect(calls).toEqual([{ questions }])
    }),
  )

  it.effect("leaves a well-formed payload untouched", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineCapturing("qplain", questionish, calls)
      const questions = [{ question: "Which first?", options: ["a"] }]

      const exit = yield* execute({ questions }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual([{ questions }])
    }),
  )

  it.effect("still reports the original schema error when parsing cannot save it", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineCapturing("qbad", questionish, calls)

      // Parses fine as JSON, but the decoded shape is still missing `question`.
      const exit = yield* execute({ questions: JSON.stringify([{ options: ["a"] }]) }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      const error = exit.cause.reasons.find(Cause.isDieReason)?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      expect(calls).toEqual([])
    }),
  )

  it.effect("does not mangle a genuine string argument", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineCapturing("qstr", Schema.Struct({ input: Schema.String }), calls)

      // Strings that are not JSON objects/arrays must survive verbatim, even
      // when they merely look structural.
      for (const input of ["/some/path", "not json at all", "[unclosed", "{also unclosed"]) {
        const exit = yield* execute({ input }, makeCtx()).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }
      expect(calls).toEqual([
        { input: "/some/path" },
        { input: "not json at all" },
        { input: "[unclosed" },
        { input: "{also unclosed" },
      ])
    }),
  )
})

describe("Tool.coerceJsonStringProperties", () => {
  const coerce = Tool.coerceJsonStringProperties

  it.effect("parses JSON array and object strings", () =>
    Effect.sync(() => {
      expect(coerce({ a: "[1,2]" })).toEqual({ a: [1, 2] })
      expect(coerce({ a: '{"k":"v"}' })).toEqual({ a: { k: "v" } })
    }),
  )

  it.effect("returns the identical reference when nothing changed", () =>
    Effect.sync(() => {
      // Identity matters: the decode path uses `coerced === args` to decide
      // whether a retry is even worth attempting.
      const args = { a: "plain", b: 1 }
      expect(coerce(args)).toBe(args)
    }),
  )

  it.effect("skips scalars that happen to be valid JSON", () =>
    Effect.sync(() => {
      // "42" parses to a number, not a structure - replacing it could turn a
      // legitimately-string argument into the wrong type.
      const args = { a: "42", b: "true", c: "null", d: '"quoted"' }
      expect(coerce(args)).toBe(args)
    }),
  )

  it.effect("passes through non-object payloads", () =>
    Effect.sync(() => {
      expect(coerce(null)).toBeNull()
      expect(coerce("string")).toBe("string")
      expect(coerce([1, 2])).toEqual([1, 2])
      expect(coerce(undefined)).toBeUndefined()
    }),
  )

  it.effect("tolerates surrounding whitespace", () =>
    Effect.sync(() => {
      expect(coerce({ a: '  [{"x":1}]  ' })).toEqual({ a: [{ x: 1 }] })
    }),
  )

  it.effect("only rewrites the offending property", () =>
    Effect.sync(() => {
      expect(coerce({ good: "keep me", bad: "[1]", n: 3 })).toEqual({ good: "keep me", bad: [1], n: 3 })
    }),
  )
})

// The `question` tool's declared repair. Models very often send `header` +
// `options` and omit `question` entirely (126 of 206 recorded argument
// failures on this instance; 125 of those carried both other fields).
describe("Tool.Def.repairArguments", () => {
  const questionish = Schema.Struct({
    questions: Schema.Array(
      Schema.Struct({ question: Schema.String, header: Schema.String, options: Schema.Array(Schema.String) }),
    ),
  })

  const defineWithRepair = (id: string, calls: unknown[]) =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        id,
        Effect.succeed({
          description: "test tool",
          parameters: questionish as any,
          repairArguments: QuestionTool.repairArguments,
          execute(args: unknown) {
            calls.push(args)
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      return tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
    })

  it.effect("backfills a missing question from header", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineWithRepair("qrepair", calls)

      const exit = yield* execute(
        { questions: [{ header: "Which first?", options: ["a", "b"] }] },
        makeCtx(),
      ).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual([{ questions: [{ question: "Which first?", header: "Which first?", options: ["a", "b"] }] }])
    }),
  )

  it.effect("recovers a payload with BOTH faults at once", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineWithRepair("qboth", calls)

      // Stringified array AND a missing `question` -- the exact reported shape.
      const raw = JSON.stringify([{ header: "VAC perm items", options: ["a"] }])
      const exit = yield* execute({ questions: raw }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual([{ questions: [{ question: "VAC perm items", header: "VAC perm items", options: ["a"] }] }])
    }),
  )

  it.effect("never overwrites a question the model did supply", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineWithRepair("qkeep", calls)
      const questions = [{ question: "Real prompt", header: "Short", options: ["a"] }]

      const exit = yield* execute({ questions }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toEqual([{ questions }])
    }),
  )

  it.effect("declines when there is no header to derive from", () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const execute = yield* defineWithRepair("qnohdr", calls)

      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([])
    }),
  )

  it.effect("treats a blank header as absent", () =>
    Effect.sync(() => {
      const args = { questions: [{ header: "   ", options: ["a"] }] }
      expect(QuestionTool.repairArguments(args)).toBe(args)
    }),
  )

  it.effect("returns an identical reference when nothing needed repair", () =>
    Effect.sync(() => {
      const args = { questions: [{ question: "Q", header: "H", options: [] }] }
      expect(QuestionTool.repairArguments(args)).toBe(args)
      const notQuestions = { other: 1 }
      expect(QuestionTool.repairArguments(notQuestions)).toBe(notQuestions)
    }),
  )
})
