import type { LLMAdapter, Message, Tool, LLMResponse, ContentBlock } from "./adapter.js"

const DEFAULT_BASE_URL = "http://localhost:11434"
const DEFAULT_MODEL = "qwen3:8b"
const DEFAULT_TIMEOUT_MS = 120000

// ─── Ollama native API types ──────────────────────────────────────────────────

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> }
  }>
}

interface OllamaToolDef {
  type: "function"
  function: {
    name: string
    description: string
    parameters: { type: "object"; properties: Record<string, unknown>; required: string[] }
  }
}

interface OllamaResponse {
  model: string
  message: {
    role: "assistant"
    content: string
    tool_calls?: Array<{
      function: { name: string; arguments: Record<string, unknown> }
    }>
  }
  done: boolean
  done_reason?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

function convertMessages(systemPrompt: string, messages: Message[]): OllamaMessage[] {
  const result: OllamaMessage[] = [{ role: "system", content: systemPrompt }]

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content })
      continue
    }

    const blocks = msg.content as ContentBlock[]

    if (msg.role === "assistant") {
      const toolUseBlocks = blocks.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      )
      if (toolUseBlocks.length > 0) {
        result.push({
          role: "assistant",
          content: "",
          tool_calls: toolUseBlocks.map((b) => ({
            function: { name: b.name, arguments: b.input },
          })),
        })
      }
    } else {
      // user role with tool_result blocks — each becomes a separate tool message
      const resultBlocks = blocks.filter(
        (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result"
      )
      for (const block of resultBlocks) {
        result.push({ role: "tool", content: block.content })
      }
    }
  }

  return result
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class OllamaAdapter implements LLMAdapter {
  private baseUrl: string
  private model: string
  private timeoutMs: number
  private think: boolean

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL
    this.model = process.env.OLLAMA_MODEL ?? DEFAULT_MODEL
    this.timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS))
    this.think = process.env.OLLAMA_THINK === "true"
  }

  async send(systemPrompt: string, messages: Message[], tools: Tool[]): Promise<LLMResponse> {
    const ollamaMessages = convertMessages(systemPrompt, messages)
    const ollamaTools: OllamaToolDef[] = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: ollamaMessages,
          tools: ollamaTools,
          stream: false,
          think: this.think,
          options: { num_predict: 4096 },
        }),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const name = (err as Error).name
      if (name === "AbortError") {
        throw new Error(`Tiempo de espera agotado (${this.timeoutMs / 1000}s) al contactar Ollama`)
      }
      throw new Error(
        `Error conectando a Ollama en ${this.baseUrl}: ${(err as Error).message}`
      )
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`Error Ollama (${res.status}): ${body}`)
    }

    const data: OllamaResponse = await res.json()
    const msg = data.message
    const text = stripThinking(msg.content ?? "")

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        type: "tool_use",
        text,
        toolCalls: msg.tool_calls.map((tc, i) => ({
          id: `call_${Date.now()}_${i}`,
          name: tc.function.name,
          input: tc.function.arguments,
        })),
      }
    }

    return { type: "text", text }
  }

  get modelName(): string {
    return this.model
  }

  get providerName(): string {
    return "ollama"
  }
}
