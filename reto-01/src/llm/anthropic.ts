import Anthropic from "@anthropic-ai/sdk"
import type { LLMAdapter, Message, Tool, LLMResponse, ContentBlock } from "./adapter.js"

const DEFAULT_MODEL = "claude-sonnet-4-5"
const DEFAULT_MAX_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 30000

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((msg): Anthropic.MessageParam => {
    if (typeof msg.content === "string") {
      return { role: msg.role as "user" | "assistant", content: msg.content }
    }

    const blocks = msg.content as ContentBlock[]

    if (msg.role === "assistant") {
      return {
        role: "assistant",
        content: blocks
          .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({
            type: "tool_use" as const,
            id: b.id,
            name: b.name,
            input: b.input,
          })),
      }
    }

    return {
      role: "user",
      content: blocks
        .filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result")
        .map((b) => ({
          type: "tool_result" as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
        })),
    }
  })
}

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic
  private model: string
  private maxTokens: number
  private timeoutMs: number

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada")
    this.client = new Anthropic({ apiKey })
    this.model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL
    this.maxTokens = parseInt(process.env.MAX_TOKENS_PER_SESSION ?? String(DEFAULT_MAX_TOKENS))
    this.timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS))
  }

  async send(systemPrompt: string, messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Tiempo de espera agotado (${this.timeoutMs}ms) al contactar Anthropic`)),
        this.timeoutMs
      )
    )

    const requestPromise = this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: convertMessages(messages),
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
    })

    let response: Anthropic.Message
    try {
      response = await Promise.race([requestPromise, timeoutPromise])
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Error Anthropic (${err.status}): ${err.message}`)
      }
      throw err
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    )
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    )
    const text = textBlocks.map((b) => b.text).join("")

    if (toolUseBlocks.length > 0) {
      return {
        type: "tool_use",
        text,
        toolCalls: toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        })),
      }
    }

    return { type: "text", text }
  }

  get modelName(): string {
    return this.model
  }
}
