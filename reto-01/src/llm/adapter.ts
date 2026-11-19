export type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string }

export interface Message {
  role: "user" | "assistant"
  content: string | ContentBlock[]
}

export interface Tool {
  name: string
  description: string
  input_schema: {
    type: "object"
    properties: Record<string, unknown>
    required: string[]
  }
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface LLMResponse {
  type: "text" | "tool_use"
  text: string
  toolCalls?: ToolCall[]
}

export interface LLMAdapter {
  send(systemPrompt: string, messages: Message[], tools: Tool[]): Promise<LLMResponse>
}

export interface ToolCallRecord {
  name: string
  input: Record<string, unknown>
  result: string
  timestamp: string
}
