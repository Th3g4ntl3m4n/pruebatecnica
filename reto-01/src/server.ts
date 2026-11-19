import { Hono } from "hono"
import { cors } from "hono/cors"
import { join } from "path"
import { readFile } from "fs/promises"
import { z, type ZodTypeAny } from "zod"
import * as proveedorTools from "./tools/proveedor.js"
import { AnthropicAdapter } from "./llm/anthropic.js"
import { OllamaAdapter } from "./llm/ollama.js"
import type { LLMAdapter, Tool, Message, ToolCallRecord, ContentBlock } from "./llm/adapter.js"

// ─── Config ───────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..")
const PORT = parseInt(process.env.PORT ?? "3000")
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS ?? "25")

// ─── Session store ────────────────────────────────────────────────────────────

interface Session {
  id: string
  messages: Message[]
  toolCalls: ToolCallRecord[]
}

const sessions = new Map<string, Session>()

function getOrCreateSession(sessionId: string): Session {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { id: sessionId, messages: [], toolCalls: [] })
  }
  return sessions.get(sessionId)!
}

// ─── Zod → JSON Schema converter ─────────────────────────────────────────────

function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const description = schema.description
  const desc: Record<string, unknown> = description ? { description } : {}

  if (schema instanceof z.ZodString) return { type: "string", ...desc }
  if (schema instanceof z.ZodBoolean) return { type: "boolean", ...desc }
  if (schema instanceof z.ZodNumber) return { type: "number", ...desc }

  if (schema instanceof z.ZodArray) {
    const arr = schema as z.ZodArray<ZodTypeAny>
    return { type: "array", items: zodToJsonSchema(arr.element), ...desc }
  }

  if (schema instanceof z.ZodOptional) {
    const opt = schema as z.ZodOptional<ZodTypeAny>
    return zodToJsonSchema(opt.unwrap())
  }

  if (schema instanceof z.ZodObject) {
    const obj = schema as z.ZodObject<Record<string, ZodTypeAny>>
    const shape = obj.shape
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val)
      if (!(val instanceof z.ZodOptional)) required.push(key)
    }
    return { type: "object", properties, required, ...desc }
  }

  return { type: "string", ...desc }
}

// ─── Build tool definitions ───────────────────────────────────────────────────

type ToolExport = {
  description: string
  args: Record<string, ZodTypeAny>
  execute: (args: Record<string, unknown>, ctx: { directory: string; sessionId: string }) => Promise<string>
}

const FILE_PREFIX = "proveedor"
const toolExports = proveedorTools as Record<string, ToolExport>

const anthropicTools: Tool[] = Object.entries(toolExports).map(([name, tool]) => {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, val] of Object.entries(tool.args)) {
    properties[key] = zodToJsonSchema(val)
    if (!(val instanceof z.ZodOptional)) required.push(key)
  }
  return {
    name: `${FILE_PREFIX}_${name}`,
    description: tool.description,
    input_schema: { type: "object" as const, properties, required },
  }
})

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: { directory: string; sessionId: string }
): Promise<string> {
  const withoutPrefix = toolName.startsWith(`${FILE_PREFIX}_`)
    ? toolName.slice(FILE_PREFIX.length + 1)
    : null

  if (!withoutPrefix || !(withoutPrefix in toolExports)) {
    return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${toolName}` })
  }

  const tool = toolExports[withoutPrefix]
  const schema = z.object(tool.args)
  const parsed = schema.safeParse(input)

  if (!parsed.success) {
    return JSON.stringify({
      ok: false,
      error: `Argumentos inválidos para ${toolName}: ${parsed.error.message}`,
    })
  }

  try {
    return await tool.execute(parsed.data as Record<string, unknown>, ctx)
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: `Error en herramienta ${toolName}: ${err instanceof Error ? err.message : "error desconocido"}`,
    })
  }
}

// ─── Agent cycle ──────────────────────────────────────────────────────────────

async function runAgentCycle(
  session: Session,
  systemPrompt: string,
  adapter: LLMAdapter,
  directory: string
): Promise<{ reply: string; newToolCalls: ToolCallRecord[] }> {
  let iterations = 0
  let reply = ""
  const newToolCalls: ToolCallRecord[] = []

  while (iterations < MAX_ITERATIONS) {
    iterations++

    let response
    try {
      response = await adapter.send(systemPrompt, session.messages, anthropicTools)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido"
      reply = `Error al contactar el modelo de lenguaje: ${msg}. La sesión continúa activa.`
      session.messages.push({ role: "assistant", content: reply })
      break
    }

    if (response.type === "text") {
      reply = response.text
      session.messages.push({ role: "assistant", content: reply })
      break
    }

    if (response.type === "tool_use" && response.toolCalls?.length) {
      // Store assistant message with tool_use blocks
      const assistantBlocks: ContentBlock[] = response.toolCalls.map((tc) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      }))
      session.messages.push({ role: "assistant", content: assistantBlocks })

      // Execute tools and collect results
      const toolResultBlocks: ContentBlock[] = []
      for (const tc of response.toolCalls) {
        const result = await executeTool(tc.name, tc.input, {
          directory,
          sessionId: session.id,
        })
        toolResultBlocks.push({
          type: "tool_result" as const,
          tool_use_id: tc.id,
          content: result,
        })
        newToolCalls.push({
          name: tc.name,
          input: tc.input,
          result,
          timestamp: new Date().toISOString(),
        })
      }
      session.messages.push({ role: "user", content: toolResultBlocks })

      if (iterations >= MAX_ITERATIONS) {
        reply = `Se alcanzó el límite de ${MAX_ITERATIONS} iteraciones. Los resultados parciales están disponibles en la carpeta out/. Puedes pedir el siguiente paso manualmente.`
        session.messages.push({ role: "assistant", content: reply })
        break
      }
    }
  }

  session.toolCalls.push(...newToolCalls)
  return { reply, newToolCalls }
}

function detectNeedsConfirmation(text: string): boolean {
  return /¿confirm/i.test(text) || /confirma[rs]?\s+(que|si|el)/i.test(text) || /¿procedo/i.test(text)
}

// ─── Load system prompt ───────────────────────────────────────────────────────

let systemPrompt: string

async function loadSystemPrompt(): Promise<void> {
  try {
    systemPrompt = await readFile(join(PROJECT_DIR, "agent", "prompt.md"), "utf8")
  } catch {
    systemPrompt =
      "Eres un asistente de registro de proveedores para Periferia IT Group. Nunca inventes valores; úsalos solo de las herramientas."
  }
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono()
app.use("*", cors())

// POST /api/chat
app.post("/api/chat", async (c) => {
  let body: { sessionId?: string; message?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "Cuerpo JSON inválido" }, 400)
  }

  const { sessionId, message } = body
  if (!sessionId || !message) {
    return c.json({ error: "Se requieren sessionId y message" }, 400)
  }

  let adapter: LLMAdapter
  try {
    const provider = process.env.LLM_PROVIDER ?? "ollama"
    adapter = provider === "anthropic" ? new AnthropicAdapter() : new OllamaAdapter()
  } catch (err) {
    return c.json(
      { error: `Configuración del proveedor LLM: ${err instanceof Error ? err.message : "error"}` },
      500
    )
  }

  const session = getOrCreateSession(sessionId)
  session.messages.push({ role: "user", content: message })

  const { reply, newToolCalls } = await runAgentCycle(
    session,
    systemPrompt,
    adapter,
    PROJECT_DIR
  )

  return c.json({
    reply,
    toolCalls: newToolCalls,
    needsConfirmation: detectNeedsConfirmation(reply),
    sessionId,
  })
})

// GET /api/sessions/:id
app.get("/api/sessions/:id", (c) => {
  const id = c.req.param("id")
  const session = sessions.get(id)
  if (!session) return c.json({ error: "Sesión no encontrada" }, 404)
  return c.json({ sessionId: id, messages: session.messages, toolCalls: session.toolCalls })
})

// GET /api/health
app.get("/api/health", () => {
  const provider = process.env.LLM_PROVIDER ?? "ollama"
  const model =
    provider === "anthropic"
      ? (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")
      : (process.env.OLLAMA_MODEL ?? "qwen3:8b")
  return Response.json({ ok: true, provider, model, timestamp: new Date().toISOString() })
})

// Static files from web/
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
}

async function serveStatic(filePath: string): Promise<Response | null> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return null
    const ext = filePath.substring(filePath.lastIndexOf("."))
    const ct = MIME[ext] ?? "application/octet-stream"
    const buf = await file.arrayBuffer()
    return new Response(buf, { headers: { "Content-Type": ct } })
  } catch {
    return null
  }
}

app.get("/", async () => {
  return (await serveStatic(join(PROJECT_DIR, "web", "index.html"))) ??
    new Response("Not found", { status: 404 })
})

app.get("*", async (c) => {
  const reqPath = c.req.path.replace(/^\//, "")
  const res = await serveStatic(join(PROJECT_DIR, "web", reqPath))
  if (res) return res
  // SPA fallback
  return (await serveStatic(join(PROJECT_DIR, "web", "index.html"))) ??
    c.notFound()
})

// ─── Start server ─────────────────────────────────────────────────────────────

await loadSystemPrompt()

export default {
  port: PORT,
  fetch: app.fetch,
}

const _provider = process.env.LLM_PROVIDER ?? "ollama"
const _model = _provider === "anthropic"
  ? (process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5")
  : (process.env.OLLAMA_MODEL ?? "qwen3:8b")
console.log(`🚀 Servidor iniciado en http://localhost:${PORT}`)
console.log(`   Proveedor: ${_provider} | Modelo: ${_model}`)
console.log(`   Directorio del proyecto: ${PROJECT_DIR}`)
