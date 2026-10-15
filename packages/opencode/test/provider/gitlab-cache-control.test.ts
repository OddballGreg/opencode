import { describe, expect, test } from "bun:test"
import { GitLabAnthropicLanguageModel } from "gitlab-ai-provider"

const model = () =>
  new GitLabAnthropicLanguageModel("duo-chat-opus", {
    instanceUrl: "https://gitlab.com",
    getHeaders: () => ({}),
  } as any) as any

const fixture = "fixture"

const thinking = (text: string) => ({
  type: "reasoning",
  text,
  providerOptions: { gitlab: { signature: fixture } },
})

describe("gitlab-ai-provider convertPrompt cache breakpoints", () => {
  test("never puts cache_control on a thinking block", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Answer" }, thinking("Thinking")] },
    ])
    const assistant = messages[messages.length - 1]

    expect(assistant.content[1].type).toBe("thinking")
    expect(assistant.content[1].cache_control).toBeUndefined()
    expect(assistant.content[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("skips the breakpoint on a thinking-only message", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [thinking("Thinking")] },
      { role: "user", content: [{ type: "text", text: "Continue" }] },
    ])

    expect(messages[1].content[0].type).toBe("thinking")
    expect(messages[1].content[0].cache_control).toBeUndefined()
    expect(messages[2].content[0].cache_control).toEqual({ type: "ephemeral" })
  })

  test("skips redacted thinking blocks", () => {
    const { messages } = model().convertPrompt([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [{ type: "reasoning", text: "", providerOptions: { gitlab: { redactedData: "opaque" } } }],
      },
    ])

    expect(messages[1].content[0].type).toBe("redacted_thinking")
    expect(messages[1].content[0].cache_control).toBeUndefined()
  })
})
