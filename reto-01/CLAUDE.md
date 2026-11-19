# CLAUDE.md — Reto Técnico 01: Agente "Registro como Proveedor"

> Contexto de proyecto para Claude Code. Leer antes de cualquier tarea de desarrollo.

---

## Qué se está construyendo

Agente conversacional de extremo a extremo que automatiza el llenado de formularios de registro como proveedor. Stack obligatorio: **TypeScript** (Bun o Node 20+) en backend y herramientas, frontend libre (React/Svelte/Vue/HTML). El modelo LLM es elección del desarrollador; la clave va en variable de entorno, nunca en el repo ni en logs.

---

## Estructura de directorios objetivo

```
reto-01/
├── agent/
│   └── prompt.md                  # system prompt — NUNCA embebido en código
├── src/
│   ├── server.ts                  # API HTTP + ciclo del agente
│   ├── llm/
│   │   ├── adapter.ts             # interfaz: enviar(mensajes, herramientas) → respuesta
│   │   └── <proveedor>.ts         # implementación elegida
│   ├── tools/
│   │   └── proveedor.ts           # 5 herramientas exportadas
│   └── knowledge/
│       └── registro-proveedor.md  # conocimiento del proceso
├── web/                           # frontend de chat
├── fixtures/                      # NO MODIFICAR — datos entregados por Periferia
├── out/                           # generado en ejecución (no commitear)
├── demo.ts                        # corre herramientas sin clave LLM
├── .env.example                   # variables requeridas, sin valores reales
├── modulo/                        # bonus +10 pts (opcional)
│   ├── agent.md
│   ├── tools/proveedor.ts
│   └── skill/registro-proveedor/SKILL.md
├── README.md
├── SOLUCION.md
└── CLAUDE.md                      # este archivo
```

---

## Fixtures disponibles (solo lectura)

### Maestro — `fixtures/reto-01/repositorio/maestro.json`

Datos ficticios de Periferia IT Group:

| Campo clave | Valor |
|---|---|
| `razon_social` | Periferia IT Group S.A.S. |
| `nit` | 900123456 |
| `digito_verificacion` | 7 |
| `pais` | CO |
| `ciudad` / `departamento` | Medellín / Antioquia |
| `direccion` | Calle 10 # 43A-25, Oficina 501 |
| `codigo_postal` | 050021 |
| `ciiu_principal` | 6201 |
| `regimen_tributario` | Responsable de IVA |
| `numero_empleados` | 480 |
| `representante_legal.nombre` | Roberto Andrade Salazar |
| `representante_legal.identificacion` | 71555123 |
| `banco.nombre` | Bancolombia S.A. |
| `banco.tipo_cuenta` | Ahorros |
| `banco.numero_cuenta` | 03100012345 |

### Glosario — `fixtures/reto-01/glosario-campos.json`

38 sinónimos de etiquetas de clientes → claves del maestro. Ejemplos críticos:
- "RUC" → `nit`, "RTN" → `nit`, "Identificación tributaria" → `nit`
- "Domicilio fiscal" → `direccion`
- "Correo electrónico" → `contacto_comercial.email`
- "Correo de facturación" → `contacto_financiero.email`

### Soportes — `fixtures/reto-01/repositorio/soportes/index.json`

| tipo | archivo | vigencia_hasta | Estado a 2026-11-18 |
|---|---|---|---|
| `camara_comercio` | camara-comercio-2026-08.txt | 2026-09-30 | **VENCIDO** |
| `rut` | rut-2026.txt | null | vigente |
| `certificacion_bancaria` | certificacion-bancaria-2026-08.txt | 2026-12-31 | vigente |
| `parafiscales` | parafiscales-2026-07.txt | 2026-08-31 | **VENCIDO** |
| `estados_financieros` | estados-financieros-2025.txt | 2027-03-31 | vigente |
| `certificado_iso_9001` | iso-9001-2025.txt | 2028-05-20 | vigente |

> **Importante**: `camara_comercio` y `parafiscales` están vencidos. Cualquier caso que los exija producirá `listo_para_firma: false`. Esto es intencional — el agente debe detectarlo.

### Casos de prueba

| Caso | País | Formato | Archivo plantilla |
|---|---|---|---|
| `co-industrias-delta` | CO | xlsx | `plantilla-celdas.json` (17 campos, 2 hojas: "Datos Proveedor" + "Datos Bancarios") |
| `ec-corp-andina` | EC | pdf | `plantilla-campos.json` |
| `hn-agroexport-sula` | HN | xlsx | `plantilla-celdas.json` |
| `pa-logistica-istmo` | PA | pdf | `plantilla-campos.json` |

---

## Contrato de herramientas (obligatorio)

Todas en `src/tools/proveedor.ts`. Cada export produce la herramienta `proveedor_<export>`.

```ts
// Estructura obligatoria de cada herramienta
export const nombre_herramienta = {
  description: "Una frase precisa — lo único que el modelo lee para decidir cuándo llamarla",
  args: {
    campo: z.string().describe("descripción del campo")
  },
  async execute(args, ctx: { directory: string; sessionId: string }) {
    // ctx.directory = raíz del proyecto; resolver rutas desde aquí, NUNCA absolutas
    // NUNCA lanzar excepciones — siempre retornar string JSON
    return JSON.stringify({ ok: true, data: { ... } })
    // o: return JSON.stringify({ ok: false, error: "mensaje claro" })
  }
}
```

| Herramienta | Entrada | Salida `data` | Prioridad |
|---|---|---|---|
| `proveedor_leer_solicitud` | `{ caso }` | `{ pais, cliente, formato, campos[], soportes[] }` | **P0** |
| `proveedor_mapear_campos` | `{ caso, campos[] }` | `{ llenos[], faltantes[], requiere_confirmacion[] }` | **P0** |
| `proveedor_generar_formulario` | `{ caso, mapeo }` | `{ ruta, formato }` | P0 xlsx / P1 pdf / P2 portal |
| `proveedor_armar_paquete` | `{ caso }` | `{ ruta, listo_para_firma, checklist }` | **P0** |
| `proveedor_simular_envio` | `{ caso, confirmado }` | `{ ruta }` o error si no confirmado | P1 |

---

## Reglas de negocio críticas

**RN1 — Identificador tributario por país:**
- CO → NIT (Periferia lo tiene)
- EC, PE, PA → RUC (llenar con el NIT, marcar `requiere_confirmacion: "identificador extranjero"`)
- HN → RTN (ídem)

**RN2 — Datos bancarios:**
- Solo se llenan si la plantilla los pide explícitamente
- **NUNCA** incluir en `borrador-correo.md`

**RN3 — Bloqueos de `listo_para_firma`:**
- Soporte vencido → bloquea
- Soporte exigido ausente → bloquea
- Campo `faltante` → NO bloquea, pero aparece en checklist

**RN4 — Confirmación humana:**
- Ninguna acción externa sin confirmación explícita del usuario en el turno inmediatamente anterior
- El front debe resaltar visualmente este estado

**RN5 — Logging:**
- Toda ejecución escribe en `out/<caso>/log.jsonl` con `{ ts, herramienta, ok, resumen }`

---

## Reglas del ciclo del agente

| Regla | Detalle |
|---|---|
| CA1 | Tope de 25 iteraciones herramienta→modelo por turno. Al alcanzarlo, responde con lo disponible |
| CA2 | El modelo NO puede afirmar un valor que no salió de una herramienta. El prompt lo prohíbe |
| CA3 | Confirmación humana: termina el turno con pregunta explícita, solo procede si el siguiente mensaje confirma |
| CA4 | Toda llamada a herramienta queda en historial del chat Y en `out/log.jsonl` |
| CA5 | Error de herramienta o LLM: se muestra en chat en lenguaje claro, la sesión NO muere |

---

## API mínima

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo |
| `GET` | `/api/health` | `{ ok: true, provider, model }` — SIN exponer claves |

---

## Requisitos no funcionales

- **Seguridad**: clave LLM solo en variable de entorno del backend. Nunca en front, repo, logs ni respuestas de API
- **Determinismo**: `demo.ts` produce el mismo resultado en ejecuciones consecutivas (salvo timestamps). `out/` se limpia al inicio
- **Arranque**: un comando levanta todo (`bun run dev` o `docker compose up`), menos de 2 min en máquina limpia
- **TypeScript sin `any`**: funciones cortas, nombres consistentes
- **`zod` obligatorio** para validar args de herramientas
- Tope de tokens por sesión configurable (el usuario no puede agotar la clave sin límite)
- Las herramientas **no ejecutan comandos de shell**

---

## Salidas esperadas por caso (`out/<caso>/`)

```
out/<caso>/
├── formulario.xlsx  (o formulario.pdf)
├── paquete/
│   ├── formulario.xlsx  (o .pdf)
│   ├── <soportes copiados desde repositorio>
│   ├── checklist.md
│   └── borrador-correo.md
├── log.jsonl
└── ENVIO-SIMULADO.md  (solo si el usuario confirmó el envío)
```

Para el caso `ec-corp-andina` (formato portal): el agente responde `formato no soportado` y produce `out/ec-corp-andina/valores-portal.md` con valores listos para copiar.

---

## Front de chat — requisitos mínimos

- Historial de conversación
- Campo de entrada + indicador "pensando"
- **Mostrar cada tool call**: nombre, argumentos, resultado resumido
- **Resaltar cuando el agente pide confirmación** (estado `needsConfirmation`)
- Streaming: opcional

---

## `demo.ts` — verificación sin modelo

Debe correr sin ninguna clave de proveedor:

```bash
bun install && bun run demo.ts
```

Ejecuta todos los casos de `fixtures/reto-01/casos/` llamando directamente a las herramientas e imprime un resumen por caso.

---

## Separación de responsabilidades (lo que se evalúa)

| Dónde | Qué va |
|---|---|
| `agent/prompt.md` | Comportamiento del agente (reglas, restricciones, estilo) |
| `src/knowledge/registro-proveedor.md` | Conocimiento del proceso de negocio |
| `src/tools/proveedor.ts` | Ejecución (acceso a archivos, lógica de mapeo, generación) |
| `src/llm/adapter.ts` | Interfaz del proveedor LLM |

Un cambio de reglas de negocio no debe tocar el servidor. Un cambio de proveedor LLM no debe tocar el ciclo del agente.

---

## SOLUCION.md — secciones obligatorias

1. Problema en una frase + a quién le duele
2. Arquitectura (diagrama front → backend → herramientas → archivos)
3. Ciclo del agente (bucle, tope de iteraciones, confirmación humana)
4. Elección del modelo (proveedor, modelo, por qué, costo estimado por caso)
5. Diseño del portal web (sección 7.4 del PRD)
6. Decisiones y trade-offs (mínimo 3, con alternativa descartada y razón)
7. Supuestos al interpretar el PRD
8. Cobertura de historias de usuario (tabla: hecho / parcial / no hecho)
9. Uso de IA en la construcción (qué asistentes, qué tareas, qué se descartó)
10. Riesgos de llevar a producción y mitigaciones

---

## Rúbrica (100 pts, aprobación en 70)

Referencia del PRD sección 10. Los criterios P0 son los que más peso tienen. El bonus de módulo reutilizable suma hasta +10 pts adicionales.

---

## Notas de implementación

- Rutas de archivos: **siempre relativas desde `ctx.directory`**, nunca absolutas hardcodeadas
- El campo `camara_comercio` está vencido desde 2026-09-30 — todos los casos que lo exijan tendrán `listo_para_firma: false`
- Para ec-corp-andina: el RUC se llena con el NIT colombiano y se marca `requiere_confirmacion`
- `co-industrias-delta` tiene hoja "Datos Bancarios" en la plantilla → aplicar RN2 (datos bancarios solo si la plantilla los pide, que en este caso sí los pide)
