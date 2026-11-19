/**
 * demo.ts — verifica todas las herramientas sin modelo LLM
 * Uso: bun run demo.ts
 * No requiere variables de entorno.
 */

import { rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  leer_solicitud,
  mapear_campos,
  generar_formulario,
  armar_paquete,
  simular_envio,
} from "./src/tools/proveedor"

const DIR = import.meta.dir
const ctx = { directory: DIR, sessionId: "demo" }

const CASOS = [
  "co-industrias-delta",
  "ec-corp-andina",
  "hn-agroexport-sula",
  "pa-logistica-istmo",
]

// ── colores ANSI ──────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
}

function ok(msg: string) { console.log(`  ${c.green}✓${c.reset} ${msg}`) }
function fail(msg: string) { console.log(`  ${c.red}✗${c.reset} ${msg}`) }
function info(msg: string) { console.log(`  ${c.dim}→${c.reset} ${msg}`) }
function header(msg: string) { console.log(`\n${c.bold}${c.cyan}${msg}${c.reset}`) }

function parse(raw: string): { ok: boolean; data?: Record<string, unknown>; error?: string } {
  try { return JSON.parse(raw) } catch { return { ok: false, error: "JSON inválido" } }
}

// ── limpieza inicial ──────────────────────────────────────────────────────────
async function cleanOut() {
  const outDir = join(DIR, "out")
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  console.log(`${c.dim}out/ limpiado.${c.reset}`)
}

// ── resumen por caso ──────────────────────────────────────────────────────────
interface CasoResult {
  caso: string
  formato: string
  llenos: number
  faltantes: number
  requiere_confirmacion: number
  listo_para_firma: boolean | null
  motivo_bloqueo: string
  errores: string[]
}

// ── correr un caso ────────────────────────────────────────────────────────────
async function correrCaso(caso: string): Promise<CasoResult> {
  header(`━━ ${caso} ━━`)

  const resultado: CasoResult = {
    caso,
    formato: "?",
    llenos: 0,
    faltantes: 0,
    requiere_confirmacion: 0,
    listo_para_firma: null,
    motivo_bloqueo: "",
    errores: [],
  }

  // 1. leer_solicitud
  console.log(`\n${c.bold}[1/6] leer_solicitud${c.reset}`)
  const rawSolicitud = await leer_solicitud.execute({ caso }, ctx)
  const rSolicitud = parse(rawSolicitud)
  if (!rSolicitud.ok) {
    fail(`leer_solicitud: ${rSolicitud.error}`)
    resultado.errores.push(`leer_solicitud: ${rSolicitud.error}`)
    return resultado
  }
  const solicitudData = rSolicitud.data as {
    pais: string; cliente: string; formato: string
    campos: string[]; soportes: string[]; campos_ambiguos?: string[]
  }
  resultado.formato = solicitudData.formato
  ok(`cliente: ${solicitudData.cliente} (${solicitudData.pais})`)
  ok(`formato: ${solicitudData.formato}`)
  ok(`campos: ${solicitudData.campos.length}`)
  ok(`soportes exigidos: ${solicitudData.soportes.join(", ")}`)
  if (solicitudData.campos_ambiguos?.length) {
    info(`campos ambiguos: ${solicitudData.campos_ambiguos.join(", ")}`)
  }

  // 2. mapear_campos
  console.log(`\n${c.bold}[2/6] mapear_campos${c.reset}`)
  const rawMapeo = await mapear_campos.execute({ caso, campos: solicitudData.campos }, ctx)
  const rMapeo = parse(rawMapeo)
  if (!rMapeo.ok) {
    fail(`mapear_campos: ${rMapeo.error}`)
    resultado.errores.push(`mapear_campos: ${rMapeo.error}`)
    return resultado
  }
  const mapeoData = rMapeo.data as {
    llenos: Array<{ campo: string; clave: string; valor: string }>
    faltantes: string[]
    requiere_confirmacion: Array<{ campo: string; clave: string; valor: string; nota: string }>
  }
  resultado.llenos = mapeoData.llenos.length
  resultado.faltantes = mapeoData.faltantes.length
  resultado.requiere_confirmacion = mapeoData.requiere_confirmacion.length
  ok(`llenos: ${mapeoData.llenos.length}`)
  for (const f of mapeoData.llenos) info(`  ${f.campo} → ${f.clave} = "${String(f.valor).substring(0, 50)}"`)
  if (mapeoData.faltantes.length) {
    fail(`faltantes: ${mapeoData.faltantes.join(", ")}`)
  }
  if (mapeoData.requiere_confirmacion.length) {
    console.log(`  ${c.yellow}⚠${c.reset} requiere confirmación:`)
    for (const r of mapeoData.requiere_confirmacion) info(`  ${r.campo} → ${r.valor} (${r.nota})`)
  }

  // 3. generar_formulario
  console.log(`\n${c.bold}[3/6] generar_formulario${c.reset}`)
  const rawFormulario = await generar_formulario.execute({ caso, mapeo: mapeoData }, ctx)
  const rFormulario = parse(rawFormulario)
  if (!rFormulario.ok) {
    if (solicitudData.formato === "portal") {
      info(`formato portal: no soportado → genera valores-portal.md`)
      ok(`valores-portal.md creado para copia manual`)
    } else {
      fail(`generar_formulario: ${rFormulario.error}`)
      resultado.errores.push(`generar_formulario: ${rFormulario.error}`)
    }
  } else {
    const fData = rFormulario.data as { ruta: string; formato: string }
    ok(`formulario generado: ${fData.ruta}`)
  }

  // 4. armar_paquete
  console.log(`\n${c.bold}[4/6] armar_paquete${c.reset}`)
  const rawPaquete = await armar_paquete.execute({ caso }, ctx)
  const rPaquete = parse(rawPaquete)
  if (!rPaquete.ok) {
    fail(`armar_paquete: ${rPaquete.error}`)
    resultado.errores.push(`armar_paquete: ${rPaquete.error}`)
  } else {
    const pData = rPaquete.data as {
      ruta: string; listo_para_firma: boolean
      checklist: { presentes: string[]; vencidos: string[]; ausentes: string[] }
      motivo_bloqueo?: string
    }
    resultado.listo_para_firma = pData.listo_para_firma
    resultado.motivo_bloqueo = pData.motivo_bloqueo ?? ""
    ok(`paquete: ${pData.ruta}`)
    if (pData.checklist.presentes.length) ok(`soportes presentes: ${pData.checklist.presentes.join(", ")}`)
    if (pData.checklist.vencidos.length) fail(`soportes vencidos: ${pData.checklist.vencidos.join(", ")}`)
    if (pData.checklist.ausentes.length) fail(`soportes ausentes: ${pData.checklist.ausentes.join(", ")}`)
    const signo = pData.listo_para_firma ? `${c.green}✓ LISTO${c.reset}` : `${c.red}✗ NO LISTO${c.reset}`
    console.log(`  listo_para_firma: ${signo}${pData.motivo_bloqueo ? ` — ${pData.motivo_bloqueo}` : ""}`)
  }

  // 5. simular_envio sin confirmación (debe fallar)
  console.log(`\n${c.bold}[5/6] simular_envio (sin confirmación — debe rechazar)${c.reset}`)
  const rawEnvio1 = await simular_envio.execute({ caso, confirmado: false }, ctx)
  const rEnvio1 = parse(rawEnvio1)
  if (!rEnvio1.ok) {
    ok(`rechazado correctamente: "${rEnvio1.error}"`)
  } else {
    fail(`debía rechazar pero aceptó`)
    resultado.errores.push("simular_envio aceptó sin confirmación")
  }

  // 6. simular_envio con confirmación (debe pasar)
  console.log(`\n${c.bold}[6/6] simular_envio (con confirmación — debe aceptar)${c.reset}`)
  const rawEnvio2 = await simular_envio.execute({ caso, confirmado: true }, ctx)
  const rEnvio2 = parse(rawEnvio2)
  if (rEnvio2.ok) {
    const eData = rEnvio2.data as { ruta: string }
    ok(`ENVIO-SIMULADO.md creado: ${eData.ruta}`)
  } else {
    fail(`simular_envio con confirmación falló: ${rEnvio2.error}`)
    resultado.errores.push(`simular_envio confirmado: ${rEnvio2.error}`)
  }

  return resultado
}

// ── tabla resumen ─────────────────────────────────────────────────────────────
function imprimirTabla(resultados: CasoResult[]) {
  header("\n━━ RESUMEN ━━")

  const cols = {
    caso: 23,
    formato: 8,
    llenos: 8,
    falt: 10,
    rc: 6,
    listo: 30,
  }

  const sep = "─"
  const tl = "┌", tr = "┐", bl = "└", br = "┘"
  const ml = "├", mr = "┤", cross = "┼", hor = "─", vert = "│"

  const widths = [cols.caso, cols.formato, cols.llenos, cols.falt, cols.rc, cols.listo]
  const totalW = widths.reduce((a, b) => a + b + 3, 1)

  const hdr = (w: number, t: string) => t.padEnd(w)
  const cell = (w: number, t: string) => String(t).substring(0, w).padEnd(w)

  function row(vals: string[]) {
    return `${vert} ` + vals.map((v, i) => cell(widths[i], v)).join(` ${vert} `) + ` ${vert}`
  }
  function divider(l: string, m: string, r: string) {
    return l + widths.map(w => hor.repeat(w + 2)).join(m) + r
  }

  console.log(divider(tl, "┬", tr))
  console.log(row(["Caso", "Formato", "Llenos", "Faltantes", "RC", "listo_para_firma"]))
  console.log(divider(ml, cross, mr))

  for (const r of resultados) {
    const listo = r.listo_para_firma === null
      ? "—"
      : r.listo_para_firma
        ? "✓ SÍ"
        : `✗ NO — ${r.motivo_bloqueo}`
    console.log(row([
      r.caso,
      r.formato,
      String(r.llenos),
      String(r.faltantes),
      String(r.requiere_confirmacion),
      listo,
    ]))
  }

  console.log(divider(bl, "┴", br))

  // errores
  const conErrores = resultados.filter(r => r.errores.length > 0)
  if (conErrores.length) {
    console.log(`\n${c.red}${c.bold}Errores detectados:${c.reset}`)
    for (const r of conErrores) {
      console.log(`  ${c.red}${r.caso}:${c.reset} ${r.errores.join("; ")}`)
    }
  } else {
    console.log(`\n${c.green}${c.bold}Todos los casos ejecutaron sin errores.${c.reset}`)
  }

  const rc = `RC = requiere_confirmacion (campo mapeado con advertencia por regla de país)`
  console.log(`\n${c.dim}${rc}${c.reset}`)
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${c.bold}${c.cyan}═══ demo.ts — Reto 01: Agente Registro como Proveedor ═══${c.reset}`)
  console.log(`${c.dim}Ejecuta herramientas directamente, sin modelo LLM.${c.reset}\n`)

  await cleanOut()

  const resultados: CasoResult[] = []
  for (const caso of CASOS) {
    const r = await correrCaso(caso)
    resultados.push(r)
  }

  imprimirTabla(resultados)
}

main().catch(err => {
  console.error(`\n${c.red}Error fatal:${c.reset}`, err)
  process.exit(1)
})
