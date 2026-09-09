import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMRequestPrep } from "@/session/llm/request"
import { jsonSchema, type ModelMessage } from "ai"

/**
 * Anthropic rejects any request whose message array ends on an assistant turn:
 *
 *   400 invalid_request_error - "This model does not support assistant message
 *   prefill. The conversation must end with a user message."
 *
 * These cover the V1 request path (`LLMRequestPrep.prepare`), which is the
 * single funnel every V1 request -- subagents included -- passes through. The
 * previously shipped guard lived only in the V2 core runner
 * (`@opencode-ai/core/session/runner/llm`), so the V1 path stayed unprotected
 * and kept 400ing. Observed on ses_f7a4cd20dffe8Emv6ieSaAggBf and
 * ses_f7a4c72bfffe6YTJIDrID8F8La (deep review + antagonist review of !250824).
 */
describe("ensureTrailingUserMessage", () => {
  const { ensureTrailingUserMessage, CONTINUE_PROMPT } = LLMRequestPrep

  test("appends a continuation user turn when the history ends on an assistant message", () => {
    // The shape observed in the wild: a step emitted text with NO tool call, so
    // no tool result followed to re-anchor the history.
    const messages: ModelMessage[] = [
      { role: "user", content: "review this" },
      { role: "assistant", content: "done" },
    ]
    const result = ensureTrailingUserMessage(messages)
    expect(result.at(-1)?.role).toBe("user")
    expect(result.at(-1)?.content).toBe(CONTINUE_PROMPT)
    expect(result).toHaveLength(3)
  })

  test("leaves a history already ending on a user message untouched", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: "working" },
      { role: "user", content: "carry on" },
    ]
    expect(ensureTrailingUserMessage(messages)).toEqual(messages)
  })

  test("leaves a history ending on a tool result untouched", () => {
    // The common case, and why this bug reads as intermittent rather than
    // constant: the trailing tool result satisfies the invariant by accident.
    const messages: ModelMessage[] = [
      { role: "user", content: "review this" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "ok" } }],
      },
    ]
    expect(ensureTrailingUserMessage(messages)).toEqual(messages)
  })

  test("treats a trailing system message as an unsafe terminator", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "system", content: "be brief" },
    ]
    expect(ensureTrailingUserMessage(messages).at(-1)?.role).toBe("user")
  })

  test("is idempotent - appends at most one continuation turn", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "review this" },
      { role: "assistant", content: "done" },
    ]
    const once = ensureTrailingUserMessage(messages)
    expect(ensureTrailingUserMessage(once)).toEqual(once)
  })

  test("leaves an empty history untouched", () => {
    expect(ensureTrailingUserMessage([])).toEqual([])
  })

  test("leaves a content-free trailing assistant turn untouched", () => {
    // An empty reasoning-only turn is stripped before the wire (the Gemini
    // transform does exactly this), so padding after one would inject a
    // spurious "Continue." into a request that was never at risk.
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "reasoning", text: "" }] },
    ]
    expect(ensureTrailingUserMessage(messages)).toEqual(messages)
  })

  test("still pads a trailing assistant turn that has real content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]
    expect(ensureTrailingUserMessage(messages).at(-1)?.content).toBe(CONTINUE_PROMPT)
  })
})

describe("LLMRequestPrep.prepare enforces the trailing-user invariant", () => {
  const sessionID = "test-session-prefill"

  const model = {
    id: "anthropic/claude-sonnet-4-5",
    providerID: "anthropic",
    api: { id: "claude-sonnet-4-5", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    name: "Claude Sonnet 4.5",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
    },
    options: {},
    headers: {},
    variants: {},
    limit: { context: 200_000, output: 64_000 },
  }

  const prepare = (messages: ModelMessage[], overrides: Record<string, unknown> = {}) =>
    Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_user-prefill",
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: "general",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        } as any,
        sessionID,
        model: model as any,
        agent: { name: "general", mode: "subagent", options: {}, permission: [] } as any,
        system: ["be helpful"],
        messages,
        tools: {
          lookup: { description: "Look up a value", inputSchema: jsonSchema({ type: "object", properties: {} }) },
        },
        provider: { id: "anthropic", options: {} } as any,
        auth: undefined,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
        ...overrides,
      } as any),
    )

  test("a prepared request never ends on an assistant turn", async () => {
    const prepared = await prepare([
      { role: "user", content: "review this" },
      { role: "assistant", content: "done" },
    ])
    expect(prepared.messages.at(-1)?.role).toBe("user")
    expect(prepared.messages.at(-1)?.content).toBe(LLMRequestPrep.CONTINUE_PROMPT)
  })

  test("a prepared request already ending on a user turn is not padded", async () => {
    const prepared = await prepare([{ role: "user", content: "review this" }])
    expect(prepared.messages.at(-1)?.content).toBe("review this")
  })

  test("the workflow passthrough branch is also protected", async () => {
    // isWorkflow bypasses system-message prepending, so it must not bypass the
    // invariant with it.
    const prepared = await prepare(
      [
        { role: "user", content: "review this" },
        { role: "assistant", content: "done" },
      ],
      { isWorkflow: true },
    )
    expect(prepared.messages.at(-1)?.role).toBe("user")
  })
})
