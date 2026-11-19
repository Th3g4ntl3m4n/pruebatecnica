# SOLUCION.md — Reto Técnico 01: Agente "Registro como Proveedor"

---

## 1. Problema en una frase

El área administrativa de Periferia transcribe manualmente entre 8 y 12 formularios de registro de proveedor al mes usando datos que ya existen en un repositorio interno, con riesgo de error en datos sensibles y dependencia de una sola persona.

**A quién le duele:** la analista administrativa que hace la transcripción campo por campo y busca los soportes en cada solicitud.

---

## 2. Arquitectura

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Navegador (web/)                                                            │
│  index.html + app.js + style.css                                             │
│  - historial de mensajes                                                     │
│  - tool calls expandibles (nombre, args, resultado)                          │
│  - banner de confirmación cuando needsConfirmation: true                     │
└────────────────────────┬─────────────────────────────────────────────────────┘
                         │  POST /api/chat  { sessionId, message }
                         │  ←  { reply, toolCalls[], needsConfirmation }
                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Backend (src/server.ts) — Hono + Bun                                        │
│                                                                              │
│  Ciclo del agente:                                                           │
│    mensajes[] → LLM → tool_use → execute() → tool_result → LLM → texto     │
│    (máx. MAX_ITERATIONS = 25 vueltas)                                        │
│                                                                              │
│  Sesiones: Map<sessionId, { messages[], toolCalls[] }> en memoria            │
│                                                                              │
│  src/llm/adapter.ts    ← interfaz LLMAdapter (proveedor-agnóstica)           │
│  src/llm/ollama.ts     ← implementación Ollama/Qwen3 (activa)               │
│  src/llm/anthropic.ts  ← implementación Anthropic Claude (alternativa)      │
│  LLM_PROVIDER=ollama|anthropic selecciona el adaptador al arrancar          │
└───────────┬──────────────────────────────────┬───────────────────────────────┘
            │                                  │
            ▼                                  ▼
┌───────────────────────┐          ┌────────────────────────────┐
│  src/tools/           │          │  Comportamiento y saber    │
│  proveedor.ts         │          │                            │
│                       │          │  agent/prompt.md           │
│  proveedor_leer_      │          │  → reglas del agente       │
│    solicitud          │          │  → formato de respuesta    │
│  proveedor_mapear_    │          │  → cuándo pedir confirm.   │
│    campos             │          │                            │
│  proveedor_generar_   │          │  src/knowledge/            │
│    formulario         │          │  registro-proveedor.md     │
│  proveedor_armar_     │          │  → proceso de negocio      │
│    paquete            │          │  → reglas por país         │
│  proveedor_simular_   │          │  → glosario de sinónimos   │
│    envio              │          └────────────────────────────┘
└───────────┬───────────┘
            │
      ┌─────┴──────┐
      ▼            ▼
fixtures/        out/
(solo lectura)   (escritura)
  maestro.json     <caso>/formulario.xlsx|pdf
  glosario.json    <caso>/paquete/
  casos/<caso>/    <caso>/log.jsonl
  soportes/        <caso>/ENVIO-SIMULADO.md
```

**Separación evaluada:**
- **Comportamiento** → `agent/prompt.md` (cambiar reglas no toca el servidor)
- **Conocimiento** → `src/knowledge/registro-proveedor.md` (cambiar el proceso no toca el código)
- **Ejecución** → `src/tools/proveedor.ts` (cada herramienta, aislada y testeable sin LLM)

---

## 3. Ciclo del agente

El ciclo vive en `src/server.ts` dentro del handler de `POST /api/chat`:

```
1. Cargar herramientas de src/tools/proveedor.ts → formato Anthropic tool_definitions[]
2. Agregar mensaje del usuario al historial de la sesión
3. Loop (contador < MAX_ITERATIONS, default 25):
   a. LLMAdapter.send(mensajes, herramientas) → respuesta
   b. Si respuesta.type === "text": salir del loop
   c. Si respuesta.type === "tool_use":
      - Para cada tool_call:
          · Validar args con el esquema Zod de la herramienta
          · Si falla validación: resultado = { ok: false, error: "..." }
          · Si pasa: ejecutar herramienta con (args, ctx)
          · Registrar en toolCalls[] y en out/<caso>/log.jsonl
      - Agregar al historial: mensaje asistente + mensajes tool_result
      - Continuar loop
4. Si contador === MAX_ITERATIONS: terminar con resumen parcial
5. Detectar needsConfirmation: texto final contiene pregunta de confirmación explícita
6. Devolver { reply, toolCalls[], needsConfirmation }
```

**Confirmación humana (CA3):** cuando el agente necesita ejecutar `proveedor_simular_envio`, el system prompt lo obliga a terminar el turno con una pregunta explícita al usuario. El ciclo no ejecuta ningún envío en ese turno. Solo en el siguiente turno, si el usuario confirma, se llama `simular_envio({ confirmado: true })`.

**Tope de iteraciones:** configurable via `MAX_ITERATIONS` en `.env`. El valor por defecto es 25. Al alcanzarlo, el agente responde con lo completado y lista lo que falta.

**Tope de tokens:** configurable via `MAX_TOKENS_PER_SESSION`. Se acumula por sesión y se rechaza el turno si se supera, con mensaje claro al usuario.

---

## 4. Elección del modelo

### Proveedor activo: Ollama (local) con Qwen3:8b

| Parámetro | Valor |
|---|---|
| **Proveedor** | Ollama (local) |
| **Modelo** | `qwen3:8b` |
| **Por qué** | Costo **cero** por token — corre 100 % en la máquina del desarrollador. Qwen3:8b soporta tool calling nativo en Ollama y maneja bien instrucciones estructuradas en español. El modelo de razonamiento (`think`) se desactiva (`OLLAMA_THINK=false`) para reducir latencia en el flujo de herramientas. |
| **Tamaño del modelo** | 5.2 GB (Q4_K_M) — corre en CPU/GPU sin GPU dedicada |
| **Latencia por caso** | ~30–90 s por turno (4 herramientas encadenadas) en CPU |
| **Costo estimado por caso** | **USD 0.00** (inferencia local) |
| **Alternativa disponible** | Anthropic `claude-sonnet-4-5` vía `LLM_PROVIDER=anthropic`. Mayor velocidad y calidad de seguimiento de instrucciones, con costo ~USD 0.03–0.12 por caso. |

La arquitectura del adaptador es proveedor-agnóstica: `src/llm/adapter.ts` define la interfaz `LLMAdapter`, y cambiar de proveedor solo requiere editar la variable `LLM_PROVIDER` en `.env` sin tocar el ciclo del agente ni las herramientas.

**Seguridad:** cuando se usa Ollama, no hay clave de API que proteger. Cuando se usa Anthropic, la clave vive exclusivamente en `ANTHROPIC_API_KEY` en el backend — nunca en el frontend, en logs ni en respuestas de la API.

---

## 5. Diseño del portal web (formato no implementado)

### Estrategia de automatización

Para portales web con usuario y contraseña se usaría **Playwright** controlado por el agente:

1. El agente prepara todos los valores en `out/<caso>/valores-portal.md` (siempre disponible como fallback).
2. El agente abre el portal con Playwright en modo headed (visible al usuario).
3. El agente rellena los campos de texto y selecciona los valores de los dropdowns.
4. **El humano ingresa las credenciales** (usuario y contraseña) directamente en el navegador. El agente nunca escribe credenciales.
5. El agente espera confirmación del humano antes de hacer clic en "Enviar".
6. El humano hace clic en "Enviar" (o lo confirma en el chat para que el agente lo haga).

### Dónde viven las credenciales

- En variables de entorno del backend: `PORTAL_<CLIENTE>_USER` y `PORTAL_<CLIENTE>_PASS`.
- **Nunca** en el repositorio, en el system prompt, en los mensajes al modelo, ni en logs.
- Quien provee las credenciales es la analista administrativa; se configuran una vez en `.env`.
- Como alternativa más segura: un gestor de secretos (AWS Secrets Manager, HashiCorp Vault).

### Límites y casos fallidos

| Escenario | Comportamiento |
|---|---|
| CAPTCHA | El agente detecta el CAPTCHA y pide al humano que lo resuelva antes de continuar. |
| MFA / 2FA | El agente espera la OTP; el humano la ingresa directamente en el navegador. |
| Cambio de layout | El selector CSS falla → el agente produce `valores-portal.md` y pide que el humano llene el portal manualmente. |
| Portal no disponible | Error con timeout → el agente entrega `valores-portal.md` como alternativa. |

### División agente / humano

| Paso | Responsable |
|---|---|
| Preparar valores | Agente |
| Abrir portal y navegar al formulario | Agente |
| Rellenar campos de datos | Agente |
| Ingresar credenciales (user/pass) | Humano |
| Resolver CAPTCHA / MFA | Humano |
| Revisar formulario antes de enviar | Humano |
| Clic en "Enviar" | Humano (o agente con confirmación explícita) |

---

## 6. Decisiones y trade-offs

### Trade-off 1: Hono vs Express para el servidor HTTP

| | Hono | Express |
|---|---|---|
| Integración con Bun | Nativa (`Bun.serve`) | Requiere `@hono/node-server` o adaptador |
| Tipado | Excelente, genéricos en rutas | Limitado sin extensiones |
| Ecosistema | Más nuevo, menor comunidad | Maduro, amplia documentación |
| **Decisión** | **Hono** | — |

**Por qué:** Hono se integra idiomáticamente con Bun sin adaptadores, tiene tipado superior y el overhead es mínimo para una API de un único proceso.

### Trade-off 2: pdf-lib vs pdfkit para generación PDF

| | pdf-lib | pdfkit |
|---|---|---|
| Dependencias nativas | Ninguna (pure JS) | Tiene bindings nativos opcionales |
| Generación desde cero | API moderna y clara | Excelente, muy usada |
| Compatibilidad Bun | Perfecta | Puede requerir workarounds |
| **Decisión** | **pdf-lib** | — |

**Por qué:** pdf-lib es pure-JS/TypeScript sin compilación nativa, garantizando compatibilidad con Bun en cualquier plataforma sin pasos de build adicionales.

### Trade-off 3: Sesiones en memoria (Map) vs persistencia en base de datos

| | Map en memoria | SQLite / PostgreSQL |
|---|---|---|
| Complejidad | Mínima | Requiere esquema, migraciones |
| Requisito del PRD | Permitido | No requerido |
| Pérdida de datos | Al reiniciar el proceso | Durable |
| Despliegue | Sin dependencias externas | Requiere BD o volumen |
| **Decisión** | **Map en memoria** | — |

**Por qué:** el PRD lo permite explícitamente ("Memoria o archivos en `out/` bastan"). La persistencia durable es un riesgo de producción documentado en la sección 10, no un requisito de este reto.

### Trade-off 4: Vanilla JS vs React para el frontend

| | Vanilla JS | React |
|---|---|---|
| Sin build step | Sí (sirve directo desde Hono) | No (necesita Vite o similar) |
| Complejidad de deploy | Mínima | +1 proceso o build previo |
| Mantenibilidad a escala | Limitada | Superior |
| **Decisión** | **Vanilla JS** | — |

**Por qué:** para una interfaz de chat de demostración, el overhead de un bundler complica el despliegue sin aportar valor. El PRD acepta "HTML plano".

---

## 7. Supuestos al interpretar el PRD

1. **`ctx.directory`** es la raíz del proyecto (`reto-01/`). Las herramientas resuelven todas las rutas relativas a este valor, nunca con `__dirname` absoluto hardcodeado.

2. **Glosario case-sensitive**: la búsqueda en `glosario-campos.json` se hace respetando mayúsculas/minúsculas ya que las etiquetas de la plantilla vienen tal como el cliente las definió. Si no hay match exacto, se intenta una búsqueda case-insensitive como fallback antes de marcar como `faltante`.

3. **"Número de contribuyente especial"** (ec-corp-andina) no existe en el maestro ni en el glosario → se marca como `faltante`. No se inventa ningún valor.

4. **"Referencias comerciales"** (hn-agroexport-sula) no existe en el maestro → se marca como `faltante`.

5. **Formato portal** (pa-logistica-istmo): la herramienta `generar_formulario` retorna `{ ok: false, error: "formato no soportado" }` y genera `valores-portal.md`. Esta respuesta no es un error fatal; el agente la comunica al usuario y continúa con `armar_paquete`.

6. **`vigencia_hasta: null`** (ej. RUT) se interpreta como "sin vencimiento" y el soporte se trata como vigente.

7. **Datos bancarios en RN2**: se leen si la plantilla los pide (como en co-industrias-delta que tiene hoja "Datos Bancarios") pero nunca se incluyen en `borrador-correo.md`.

8. **`pa-logistica-istmo`** es formato portal, por lo que `generar_formulario` produce `valores-portal.md` en lugar de un archivo Excel/PDF. `armar_paquete` incluye este archivo como el "formulario" del paquete.

---

## 8. Cobertura de historias de usuario

| Historia | Estado | Notas |
|---|---|---|
| **HU-1** Leer la solicitud | ✅ Hecho | `proveedor_leer_solicitud` procesa todos los formatos. Campos ambiguos reportados como `requiere_confirmacion`. |
| **HU-2** Mapear campos al maestro | ✅ Hecho | Glosario, rutas anidadas, RN1 por país. Nunca inventa valores. |
| **HU-3 P0** Generar formulario Excel | ✅ Hecho | `exceljs` con hoja y celda exactas de `plantilla-celdas.json`. |
| **HU-3 P1** Generar formulario PDF | ✅ Hecho | `pdf-lib` genera PDF con campos etiqueta → valor en orden. |
| **HU-3 P2** Formato portal | ✅ Hecho (diseño) | `valores-portal.md` generado. Automatización Playwright documentada en sección 5. |
| **HU-4** Armar paquete para firma | ✅ Hecho | `checklist.md`, `borrador-correo.md` (sin datos bancarios), copia de soportes, bloqueos de `listo_para_firma`. |
| **HU-5** Manejo de errores | ✅ Hecho | Todas las herramientas retornan `{ ok, data }` o `{ ok: false, error }`. La sesión nunca muere. |

**Falta para producción:**
- Integración real con correo (IMAP/SMTP para leer solicitudes entrantes).
- Autenticación de la analista (al menos contraseña o SSO).
- Persistencia de sesiones ante reinicios del servidor.
- Llenado automático de portales web (Playwright) con manejo robusto de CAPTCHA.
- Rotación y auditoría de la clave de API del modelo.
- Métricas de uso y alertas de costo.

---

## 9. Uso de IA en la construcción

| Herramienta | Tarea | Qué se descartó |
|---|---|---|
| **Claude Code (claude-sonnet-4-6)** | Análisis del PRD, lectura de fixtures, diseño de arquitectura | — |
| **Claude Code** | Generación paralela de código mediante 3 sub-agentes: backend (tools + server + adapters), frontend (chat UI), QA (demo.ts + SOLUCION.md + README) | Sugerencias de base de datos para sesiones (PRD no lo requiere) |
| **Claude Code** | Generación del system prompt en `agent/prompt.md` y `src/knowledge/registro-proveedor.md` | Variante con ejemplos few-shot (añade tokens innecesarios para este caso) |
| **Claude Code** | Implementación del adaptador `src/llm/ollama.ts` para Qwen3 vía Ollama | Uso de SDK de OpenAI como proxy (evita dependencia adicional) |
| **Claude Code** | Ajuste del system prompt para Qwen3 (CA2 más explícito, flujo de 4 herramientas obligatorio) | Deshabilitación de `think` a nivel de modelo (se prefiere `OLLAMA_THINK=false` como variable) |
| **Qwen3:8b (Ollama)** | Modelo LLM activo en producción local para el ciclo del agente | — |

Todo el código entregado fue revisado y es explicable por el desarrollador. Las sugerencias de abstracciones prematuras (repositorios, factories, inyección de dependencias) fueron descartadas en favor de código directo y legible.

---

## 10. Riesgos de llevar a producción

| Riesgo | Probabilidad | Mitigación |
|---|---|---|
| **El modelo inventa un campo faltante** | Media | Las herramientas son la única fuente de valores; el system prompt lo prohíbe. Revisión humana del checklist de faltantes antes de firmar. |
| **Pérdida de sesión al reiniciar el servidor** | Alta (con Map en memoria) | Migrar a Redis o SQLite para persistencia. Sesiones en archivo JSON en `out/` como alternativa mínima. |
| **Clave API agotada o suspendida** | Baja | Límite `MAX_TOKENS_PER_SESSION` configurado. Alertas de consumo en Anthropic Console. |
| **Portales web con CAPTCHA / MFA** | Alta | Flujo humano documentado. `valores-portal.md` como fallback siempre disponible. |
| **Soporte vencido bloquea todo** | Alta (ya ocurre en demo) | El checklist avisa con antelación. Integrar recordatorio automático N días antes del vencimiento. |
| **Plantillas con estructura inesperada** | Alta | El glosario cubre sinónimos conocidos. Campos sin mapeo son `faltantes` (nunca inventados). Revisar glosario periódicamente con nuevas plantillas. |
| **Datos bancarios en comunicaciones no autorizadas** | Media | RN2 está implementada en código, no solo en el prompt. `borrador-correo.md` nunca incluye datos bancarios. |
| **Escalado a más de un proceso** | Media | Map en memoria no es compartido. Migrar a almacenamiento externo antes de escalar horizontalmente. |
