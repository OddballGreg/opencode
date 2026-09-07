import { describe, expect, test } from "bun:test"
import { Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { toLLMMessages, ensureTrailingUserMessage, CONTINUE_PROMPT } from "@opencode-ai/core/session/runner/to-llm-message"
import { DateTime } from "effect"

const created = DateTime.makeUnsafe(0)
const id = (value: string) => SessionMessage.ID.make(`msg_${value}`)
const model = Model.make({ id: "model", provider: "provider", route: OpenAIChat.route })

const assistant = (value: string, content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: id(value),
    type: "assistant",
    agent: "general",
    model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    content,
    time: { created, completed: created },
  })

const text = (value: string) => SessionMessage.AssistantText.make({ type: "text", id: value, text: value })

const user = (value: string) =>
  SessionMessage.User.make({ id: id(value), type: "user", text: value, time: { created } })

const tool = (value: string) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: value,
    name: "bash",
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: {},
      content: [{ type: "text", text: "ok" }],
      structured: {},
    }),
    time: { created, completed: created },
  })

/**
 * Anthropic rejects any request whose message array ends on an assistant turn:
 *
 *   400 invalid_request_error - "This model does not support assistant message
 *   prefill. The conversation must end with a user message."
 *
 * The agent loop can produce exactly that. Each continuation step appends a new
 * assistant turn, and it is normally the *tool result* (a user-role message)
 * that re-anchors the history. When a step emits text with NO tool call there
 * is no tool result, so the next step dispatches a history ending on a bare
 * assistant turn and the provider 400s -- killing the run mid-task.
 *
 * `endsWithAssistant` is the invariant those requests must satisfy.
 */
const endsWithAssistant = (messages: readonly Message[]) => messages.at(-1)?.role === "assistant"

describe("toLLMMessages assistant-prefill invariant", () => {
  test("a tool-less assistant turn leaves the context ending on an assistant message", () => {
    // This is the shape observed in the wild (session ses_f84a390eeffedx0nHV77PGSWGb):
    // one user turn, then N assistant turns, the last of which called no tool.
    const messages = toLLMMessages([user("review this"), assistant("step-1", [text("done")])], model)
    expect(endsWithAssistant(messages)).toBe(true)
  })

  test("an assistant turn WITH a tool call is re-anchored by its tool result", () => {
    // The common case, and why this bug is intermittent rather than constant:
    // the trailing tool result is user-role, so the invariant holds by accident.
    const messages = toLLMMessages([user("review this"), assistant("step-1", [text("working"), tool("call-1")])], model)
    expect(endsWithAssistant(messages)).toBe(false)
    expect(messages.at(-1)?.role).toBe("tool")
  })

  test("consecutive tool-less assistant turns still end on an assistant message", () => {
    const messages = toLLMMessages(
      [user("review this"), assistant("step-1", [text("first")]), assistant("step-2", [text("second")])],
      model,
    )
    expect(endsWithAssistant(messages)).toBe(true)
  })

  test("a trailing user turn satisfies the invariant", () => {
    const messages = toLLMMessages([assistant("step-1", [text("done")]), user("follow up")], model)
    expect(endsWithAssistant(messages)).toBe(false)
  })
})

describe("ensureTrailingUserMessage", () => {
  const lower = (messages: readonly SessionMessage.Message[]) =>
    ensureTrailingUserMessage(toLLMMessages(messages, model))

  test("appends a user message when the context ends on an assistant turn", () => {
    const messages = lower([user("review this"), assistant("step-1", [text("done")])])
    expect(endsWithAssistant(messages)).toBe(false)
    expect(messages.at(-1)?.role).toBe("user")
    expect(messages.at(-1)?.content).toEqual([{ type: "text", text: CONTINUE_PROMPT }])
  })

  test("fixes the exact wild failure shape (tool turns then a tool-less turn)", () => {
    // ses_f84a390eeffedx0nHV77PGSWGb: 1 user, 19 tool-calling assistant turns,
    // then a text-only turn -> next step 400'd.
    const history: SessionMessage.Message[] = [user("deep review !249169")]
    for (let step = 0; step < 19; step++) {
      history.push(assistant(`tool-step-${step}`, [text("working"), tool(`call-${step}`)]))
    }
    history.push(assistant("text-only", [text("here is the summary")]))
    const messages = lower(history)
    expect(endsWithAssistant(messages)).toBe(false)
    expect(messages.at(-1)?.role).toBe("user")
  })

  test("leaves an already-valid context untouched", () => {
    const lowered = toLLMMessages([assistant("step-1", [text("done")]), user("follow up")], model)
    expect(ensureTrailingUserMessage(lowered)).toEqual(lowered)
  })

  test("does not append after a tool result", () => {
    const lowered = toLLMMessages([user("go"), assistant("step-1", [text("working"), tool("call-1")])], model)
    expect(ensureTrailingUserMessage(lowered)).toEqual(lowered)
    expect(lowered.at(-1)?.role).toBe("tool")
  })

  test("appends only one message, never a run of them", () => {
    const once = lower([user("go"), assistant("a", [text("x")])])
    expect(once.filter((message) => JSON.stringify(message.content).includes(CONTINUE_PROMPT))).toHaveLength(1)
    // Idempotent: re-running over an already-fixed array must be a no-op.
    expect(ensureTrailingUserMessage(once)).toEqual(once)
  })

  test("handles an empty context without inventing a message", () => {
    expect(ensureTrailingUserMessage([])).toEqual([])
  })

  test("appends after a trailing system message", () => {
    const lowered = toLLMMessages(
      [SessionMessage.System.make({ id: id("sys"), type: "system", text: "context", time: { created } })],
      model,
    )
    expect(lowered.at(-1)?.role).toBe("system")
    expect(ensureTrailingUserMessage(lowered).at(-1)?.role).toBe("user")
  })
})
