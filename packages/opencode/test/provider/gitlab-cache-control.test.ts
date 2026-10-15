import { describe, expect, test } from "bun:test"
import { GitLabAnthropicLanguageModel } from "gitlab-ai-provider"

const fixture = "fixture"

const model = () =>
  new GitLabAnthropicLanguageModel("duo-chat-opus", {
    instanceUrl: "https://gitlab.com",
    getHeaders: () => ({}),
  } as any) as any

const thinking = (text: string) => ({
  type: "reasoning",
  text,
  providerOptions: { gitlab: { signature: fixture } },
})

const redacted = () => ({ type: "reasoning", text: "", providerOptions: { gitlab: { redactedData: "opaque" } } })

const hasThinkingCacheControl = (messages: any[]) =>
  messages.some((msg) =>
    msg.content.some(
      (block: any) => (block.type === "thinking" || block.type === "redacted_thinking") && block.cache_control,
    ),
  )

describe("gitlab-ai-provider convertPrompt thinking blocks", () => {
  test("drops a trailing thinking block and caches the block before it", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Answer" }, thinking("Thinking")] },
    ])
    const assistant = messages.find((msg: any) => msg.role === "assistant")

    expect(assistant.content.map((block: any) => block.type)).toEqual(["text"])
    expect(assistant.content[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("drops a thinking-only assistant message", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [thinking("Thinking")] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ])

    expect(messages.map((msg: any) => msg.role)).toEqual(["user", "user"])
    expect(messages[1].content[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("drops a redacted-thinking-only assistant message", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [redacted()] },
    ])

    expect(messages.map((msg: any) => msg.role)).toEqual(["user"])
  })

  test("keeps thinking that precedes a tool call", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [thinking("Thinking"), { type: "tool-call", toolCallId: "t1", toolName: "read", input: {} }],
      },
    ])
    const assistant = messages.find((msg: any) => msg.role === "assistant")

    expect(assistant.content.map((block: any) => block.type)).toEqual(["thinking", "tool_use"])
    expect(assistant.content[0].cache_control).toBeUndefined()
    expect(assistant.content[1].cache_control).toEqual({ type: "ephemeral" })
    expect(hasThinkingCacheControl(messages)).toBe(false)
  })

  test("ends the conversation with a user message when the last turn was the assistant's", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Partial answer" }] },
    ])

    expect(messages.map((msg: any) => msg.role)).toEqual(["user", "assistant", "user"])
    expect(messages[2].content).toEqual([{ type: "text", text: "Continue.", cache_control: { type: "ephemeral" } }])
  })

  test("does not add a user message when the conversation already ends with one", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Answer" }] },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ])

    expect(messages.map((msg: any) => msg.role)).toEqual(["user", "assistant", "user"])
    expect(messages[2].content[0].text).toBe("Thanks")
  })
})
