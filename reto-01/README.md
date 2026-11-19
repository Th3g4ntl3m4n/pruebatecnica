# Prueba Tecnica Periferia — Jefferson Hernandez Correa

Agente conversacional que automatiza el llenado de formularios de registro de **Periferia IT Group** como proveedor ante sus clientes. Recibe una solicitud, mapea los campos al repositorio maestro, genera el formulario en el formato pedido (Excel, PDF o portal) y arma el paquete de soportes listo para la firma del representante legal.

**Stack:** Bun · TypeScript · Hono · Qwen3:8b (Ollama local) · ExcelJS · pdf-lib · Zod

---

## Requisitos previos

| Herramienta | Versión mínima | Instalación |
|---|---|---|
| [Bun](https://bun.sh) | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Ollama](https://ollama.com) | Cualquiera reciente | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Modelo Qwen3 | — | `ollama pull qwen3:8b` |

> **Alternativa Anthropic:** si prefieres usar Claude en lugar de Qwen3, solo necesitas una `ANTHROPIC_API_KEY`. Ver sección [Cambio de proveedor LLM](#cambio-de-proveedor-llm).

---

## Instalación y arranque

```bash
# 1. Clonar o descomprimir el proyecto
cd reto-01

# 2. Instalar dependencias
bun install

# 3. Configurar variables de entorno
cp .env.example .env
# El archivo .env ya apunta a Ollama local — no requiere edición si usas qwen3:8b

# 4. Asegúrate de que Ollama esté corriendo con el modelo
ollama serve &          # si no está corriendo como servicio
ollama pull qwen3:8b    # si no tienes el modelo descargado

# 5. Levantar backend + frontend
bun run dev
```

La aplicación queda disponible en **http://localhost:4000**.

---

## Verificación sin modelo LLM

```bash
bun run demo
```

Ejecuta las 5 herramientas directamente sobre los 4 casos de prueba e imprime un resumen sin consumir tokens ni requerir variables de entorno. Útil para verificar que las herramientas funcionan correctamente antes de conectar el LLM.

Salida esperada:

```
═══ demo.ts — Reto 01: Agente Registro como Proveedor ═══
━━ co-industrias-delta ━━
  ✓ leer_solicitud       cliente: Industrias Delta S.A.S. (CO) · xlsx · 17 campos
  ✓ mapear_campos        17 llenos · 0 faltantes · 0 requieren confirmación
  ✓ generar_formulario   out/co-industrias-delta/formulario.xlsx
  ✓ armar_paquete        listo_para_firma: NO (camara_comercio vencido)
  ✓ simular_envio        rechazado correctamente sin confirmación
  ✓ simular_envio        ENVIO-SIMULADO.md creado con confirmación
...
Todos los casos ejecutaron sin errores.
```

---

## Casos de prueba disponibles

| Caso | País | Cliente | Formato |
|---|---|---|---|
| `co-industrias-delta` | Colombia | Industrias Delta S.A.S. | Excel (xlsx) |
| `ec-corp-andina` | Ecuador | Corporación Andina de Servicios S.A. | PDF |
| `hn-agroexport-sula` | Honduras | Agroexport Sula S. de R.L. | Excel (xlsx) |
| `pa-logistica-istmo` | Panamá | Logística del Istmo S.A. | Portal web |

Prompt de ejemplo para el chat (sección 11 del PRD):

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos,
cuáles faltan, si el paquete está listo para firma y qué soportes
debo actualizar. No envíes nada todavía.
```

---

## Variables de entorno

| Variable | Requerida | Valor por defecto | Descripción |
|---|---|---|---|
| `LLM_PROVIDER` | No | `ollama` | Proveedor LLM: `ollama` o `anthropic` |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | URL base del servidor Ollama |
| `OLLAMA_MODEL` | No | `qwen3:8b` | Modelo Ollama a usar |
| `OLLAMA_THINK` | No | `false` | Activar tokens de razonamiento de Qwen3 |
| `ANTHROPIC_API_KEY` | Solo si `LLM_PROVIDER=anthropic` | — | Clave de API de Anthropic |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-5` | Modelo de Anthropic |
| `PORT` | No | `4000` | Puerto del servidor |
| `HOST` | No | `0.0.0.0` | Host del servidor |
| `MAX_ITERATIONS` | No | `25` | Máximo de iteraciones herramienta→modelo por turno |
| `MAX_TOKENS_PER_SESSION` | No | `100000` | Tope de tokens por sesión |
| `LLM_TIMEOUT_MS` | No | `120000` | Timeout llamadas al LLM (ms) |

---

## Cambio de proveedor LLM

### Usar Anthropic Claude en lugar de Qwen3

Edita `.env`:

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-5
```

No se necesita ningún cambio de código. El adaptador se selecciona automáticamente al iniciar el servidor.

### Usar otro modelo de Ollama

```env
OLLAMA_MODEL=llama3.1:8b   # o cualquier modelo con soporte de tool calling
```

---

## Estructura del proyecto

```
reto-01/
├── agent/
│   └── prompt.md                    # system prompt del agente (comportamiento)
├── src/
│   ├── server.ts                    # API HTTP + ciclo del agente (máx. 25 iteraciones)
│   ├── llm/
│   │   ├── adapter.ts               # interfaz LLMAdapter (proveedor-agnóstica)
│   │   ├── ollama.ts                # implementación Ollama/Qwen3 (activa)
│   │   └── anthropic.ts             # implementación Anthropic Claude (alternativa)
│   ├── tools/
│   │   └── proveedor.ts             # 5 herramientas Zod · nunca lanzan excepciones
│   └── knowledge/
│       └── registro-proveedor.md    # conocimiento del proceso de negocio
├── web/
│   ├── index.html                   # interfaz de chat
│   ├── app.js                       # lógica del chat (vanilla JS, sin bundler)
│   └── style.css                    # estilos (tema oscuro, responsive)
├── fixtures/                        # datos de prueba entregados por Periferia (solo lectura)
│   └── reto-01/
│       ├── casos/                   # 4 casos: co, ec, hn, pa
│       ├── repositorio/             # maestro.json + soportes/
│       └── glosario-campos.json     # 38 sinónimos → claves del maestro
├── out/                             # salidas generadas en ejecución (gitignored)
├── demo.ts                          # prueba herramientas sin LLM
├── .env.example                     # plantilla de variables de entorno
├── SOLUCION.md                      # arquitectura, decisiones y trade-offs
└── CLAUDE.md                        # contexto del proyecto para Claude Code
```

---

## API

| Método | Ruta | Cuerpo / Respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, sessionId }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok: true, provider, model, timestamp }` — sin exponer claves |

### Ejemplo de llamada

```bash
curl -X POST http://localhost:4000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"mi-sesion","message":"Procesa el caso co-industrias-delta"}'
```

---

## Herramientas del agente

| Herramienta | Entrada | Salida | Prioridad |
|---|---|---|---|
| `proveedor_leer_solicitud` | `{ caso }` | `{ pais, cliente, formato, campos[], soportes[] }` | P0 |
| `proveedor_mapear_campos` | `{ caso, campos[] }` | `{ llenos[], faltantes[], requiere_confirmacion[] }` | P0 |
| `proveedor_generar_formulario` | `{ caso, mapeo }` | `{ ruta, formato }` | P0 xlsx · P1 pdf |
| `proveedor_armar_paquete` | `{ caso }` | `{ ruta, listo_para_firma, checklist }` | P0 |
| `proveedor_simular_envio` | `{ caso, confirmado }` | `{ ruta }` o error si no confirmado | P1 |

---

## Link de prueba

> Despliegue en progreso. El agente puede correrse localmente con `bun run dev` en http://localhost:4000.
