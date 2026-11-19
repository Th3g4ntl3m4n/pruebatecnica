import { z } from "zod"
import { join } from "path"
import { readFile, writeFile, mkdir, copyFile, appendFile, access } from "fs/promises"
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

// ─── Shared types ────────────────────────────────────────────────────────────

interface Solicitud {
  id: string
  de: string
  para: string
  asunto: string
  fecha: string
  pais: string
  cliente: string
  formato: string
  cuerpo: string
  adjuntos: string[]
}

interface PlantillaCelda {
  hoja: string
  celda_etiqueta: string
  etiqueta: string
  celda_valor: string
}

interface PlantillaCampo {
  etiqueta: string
  obligatorio: boolean
}

interface SoporteIndexItem {
  tipo: string
  archivo: string
  vigencia_hasta: string | null
  pais_emisor: string
  descripcion: string
}

interface MapeoCampoLleno {
  campo: string
  clave: string
  valor: string
}

interface MapeoConfirmacion {
  campo: string
  clave: string
  valor: string
  nota: string
}

interface Mapeo {
  llenos: MapeoCampoLleno[]
  faltantes: string[]
  requiere_confirmacion: MapeoConfirmacion[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeLog(
  directory: string,
  caso: string,
  entry: { herramienta: string; ok: boolean; resumen: string }
): Promise<void> {
  try {
    const logDir = join(directory, "out", caso)
    await ensureDir(logDir)
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    await appendFile(join(logDir, "log.jsonl"), line, "utf8")
  } catch {
    // best-effort — never throw
  }
}

async function readJson<T>(
  filePath: string
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const content = await readFile(filePath, "utf8")
    return { ok: true, data: JSON.parse(content) as T }
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo leer ${filePath}: ${err instanceof Error ? err.message : "error desconocido"}`,
    }
  }
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

function formatValue(raw: unknown): string {
  if (raw === null || raw === undefined) return ""
  if (typeof raw === "boolean") return raw ? "Sí" : "No"
  if (typeof raw === "object") return JSON.stringify(raw)
  return String(raw)
}

const PAISES_RUC = new Set(["EC", "PE", "PA"])
const PAISES_RTN = new Set(["HN"])

// ─── Tool 1: leer_solicitud ───────────────────────────────────────────────────

export const leer_solicitud = {
  description:
    "Lee la solicitud del cliente, la plantilla de campos y los soportes exigidos de un caso para identificar qué información y documentos se necesitan",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  },
  async execute(
    args: { caso: string },
    ctx: { directory: string; sessionId: string }
  ): Promise<string> {
    const { caso } = args
    const { directory } = ctx
    const casoDir = join(directory, "fixtures", "reto-01", "casos", caso)

    const solResult = await readJson<Solicitud>(join(casoDir, "solicitud.json"))
    if (!solResult.ok) return JSON.stringify({ ok: false, error: solResult.error })
    const solicitud = solResult.data

    let campos: string[] = []

    if (solicitud.formato === "xlsx") {
      const plantResult = await readJson<PlantillaCelda[]>(
        join(casoDir, "plantilla-celdas.json")
      )
      if (!plantResult.ok)
        return JSON.stringify({ ok: false, error: plantResult.error })
      campos = plantResult.data.map((c) => c.etiqueta)
    } else if (solicitud.formato === "pdf" || solicitud.formato === "portal") {
      const plantResult = await readJson<PlantillaCampo[]>(
        join(casoDir, "plantilla-campos.json")
      )
      if (plantResult.ok) {
        campos = plantResult.data.map((c) => c.etiqueta)
      } else if (solicitud.formato === "pdf") {
        return JSON.stringify({ ok: false, error: plantResult.error })
      }
    }

    const sopResult = await readJson<string[]>(
      join(casoDir, "soportes-exigidos.json")
    )
    if (!sopResult.ok)
      return JSON.stringify({ ok: false, error: sopResult.error })

    return JSON.stringify({
      ok: true,
      data: {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        campos,
        soportes: sopResult.data,
        fecha_solicitud: solicitud.fecha,
        correo_cliente: solicitud.de,
        asunto: solicitud.asunto,
      },
    })
  },
}

// ─── Tool 2: mapear_campos ────────────────────────────────────────────────────

export const mapear_campos = {
  description:
    "Cruza cada campo solicitado por el cliente con el repositorio maestro de Periferia usando el glosario de sinónimos y aplica reglas de país para el identificador tributario",
  args: {
    caso: z
      .string()
      .describe("Nombre del caso para determinar el país y registrar el log"),
    campos: z
      .array(z.string())
      .describe("Lista de etiquetas de campos tal como vienen de leer_solicitud"),
  },
  async execute(
    args: { caso: string; campos: string[] },
    ctx: { directory: string; sessionId: string }
  ): Promise<string> {
    const { caso, campos } = args
    const { directory } = ctx

    const maestroResult = await readJson<Record<string, unknown>>(
      join(directory, "fixtures", "reto-01", "repositorio", "maestro.json")
    )
    if (!maestroResult.ok)
      return JSON.stringify({ ok: false, error: maestroResult.error })
    const maestro = maestroResult.data

    const glosarioResult = await readJson<Record<string, string>>(
      join(directory, "fixtures", "reto-01", "glosario-campos.json")
    )
    if (!glosarioResult.ok)
      return JSON.stringify({ ok: false, error: glosarioResult.error })
    const glosario = glosarioResult.data

    const solResult = await readJson<Solicitud>(
      join(directory, "fixtures", "reto-01", "casos", caso, "solicitud.json")
    )
    const pais = solResult.ok ? solResult.data.pais : "CO"

    const llenos: MapeoCampoLleno[] = []
    const faltantes: string[] = []
    const requiere_confirmacion: MapeoConfirmacion[] = []

    for (const campo of campos) {
      const claveGlosario = glosario[campo]
      const clave = claveGlosario ?? campo.toLowerCase().replace(/\s+/g, "_")

      const rawValue = getNestedValue(maestro, claveGlosario ?? clave)

      if (rawValue === undefined || rawValue === null || rawValue === "") {
        if (!claveGlosario) {
          faltantes.push(campo)
          continue
        }
        const directValue = getNestedValue(maestro, clave)
        if (directValue === undefined || directValue === null || directValue === "") {
          faltantes.push(campo)
          continue
        }
      }

      const finalClave = claveGlosario ?? clave
      const finalValue = getNestedValue(maestro, finalClave)

      if (finalValue === undefined || finalValue === null) {
        faltantes.push(campo)
        continue
      }

      const valor = formatValue(finalValue)

      // RN1 — identificador tributario extranjero
      if (finalClave === "nit") {
        if (PAISES_RUC.has(pais)) {
          requiere_confirmacion.push({
            campo,
            clave: finalClave,
            valor,
            nota: "identificador extranjero — Periferia solo tiene NIT colombiano (900123456-7); el cliente solicita RUC",
          })
          continue
        }
        if (PAISES_RTN.has(pais)) {
          requiere_confirmacion.push({
            campo,
            clave: finalClave,
            valor,
            nota: "identificador extranjero — Periferia solo tiene NIT colombiano (900123456-7); el cliente solicita RTN",
          })
          continue
        }
      }

      llenos.push({ campo, clave: finalClave, valor })
    }

    const resumen = `${llenos.length} llenos, ${faltantes.length} faltantes, ${requiere_confirmacion.length} requieren confirmación`
    await writeLog(directory, caso, {
      herramienta: "proveedor_mapear_campos",
      ok: true,
      resumen,
    })

    return JSON.stringify({
      ok: true,
      data: { llenos, faltantes, requiere_confirmacion },
    })
  },
}

// ─── Tool 3: generar_formulario ───────────────────────────────────────────────

const mapeoLlenoSchema = z.object({
  campo: z.string(),
  clave: z.string(),
  valor: z.string(),
})

const mapeoConfirmSchema = z.object({
  campo: z.string(),
  clave: z.string(),
  valor: z.string(),
  nota: z.string(),
})

export const generar_formulario = {
  description:
    "Genera el formulario de registro en el formato del cliente (xlsx, pdf o portal): escribe los valores mapeados en las celdas o campos indicados por la plantilla",
  args: {
    caso: z.string().describe("Nombre del caso"),
    mapeo: z
      .object({
        llenos: z.array(mapeoLlenoSchema).describe("Campos con valor del maestro"),
        faltantes: z
          .array(z.string())
          .describe("Campos sin valor en el maestro"),
        requiere_confirmacion: z
          .array(mapeoConfirmSchema)
          .describe("Campos con valor pero que requieren confirmación humana"),
      })
      .describe("Resultado de proveedor_mapear_campos"),
  },
  async execute(
    args: { caso: string; mapeo: Mapeo },
    ctx: { directory: string; sessionId: string }
  ): Promise<string> {
    const { caso, mapeo } = args
    const { directory } = ctx
    const { llenos, faltantes, requiere_confirmacion } = mapeo

    const solResult = await readJson<Solicitud>(
      join(directory, "fixtures", "reto-01", "casos", caso, "solicitud.json")
    )
    if (!solResult.ok) return JSON.stringify({ ok: false, error: solResult.error })
    const { formato } = solResult.data

    const outDir = join(directory, "out", caso)
    await ensureDir(outDir)

    // ── XLSX ──────────────────────────────────────────────────────────────────
    if (formato === "xlsx") {
      const plantResult = await readJson<PlantillaCelda[]>(
        join(directory, "fixtures", "reto-01", "casos", caso, "plantilla-celdas.json")
      )
      if (!plantResult.ok) return JSON.stringify({ ok: false, error: plantResult.error })
      const plantilla = plantResult.data

      const workbook = new ExcelJS.Workbook()

      // Group by sheet
      const sheetMap = new Map<string, PlantillaCelda[]>()
      for (const cell of plantilla) {
        if (!sheetMap.has(cell.hoja)) sheetMap.set(cell.hoja, [])
        sheetMap.get(cell.hoja)!.push(cell)
      }

      for (const [hoja, cells] of sheetMap) {
        const ws = workbook.addWorksheet(hoja)
        for (const cell of cells) {
          ws.getCell(cell.celda_etiqueta).value = cell.etiqueta
          ws.getCell(cell.celda_etiqueta).font = { bold: true }

          const lleno = llenos.find((l) => l.campo === cell.etiqueta)
          const reqConf = requiere_confirmacion.find((r) => r.campo === cell.etiqueta)
          const valor = lleno?.valor ?? reqConf?.valor ?? ""
          ws.getCell(cell.celda_valor).value = valor
          if (reqConf) {
            ws.getCell(cell.celda_valor).note = `REQUIERE CONFIRMACIÓN: ${reqConf.nota}`
          }
        }
      }

      const outPath = join(outDir, "formulario.xlsx")
      await workbook.xlsx.writeFile(outPath)

      await writeLog(directory, caso, {
        herramienta: "proveedor_generar_formulario",
        ok: true,
        resumen: `formulario.xlsx generado con ${llenos.length} campos llenos, ${faltantes.length} faltantes`,
      })

      return JSON.stringify({
        ok: true,
        data: { ruta: `out/${caso}/formulario.xlsx`, formato: "xlsx" },
      })
    }

    // ── PDF ───────────────────────────────────────────────────────────────────
    if (formato === "pdf") {
      const plantResult = await readJson<PlantillaCampo[]>(
        join(directory, "fixtures", "reto-01", "casos", caso, "plantilla-campos.json")
      )
      if (!plantResult.ok) return JSON.stringify({ ok: false, error: plantResult.error })
      const plantilla = plantResult.data

      const pdfDoc = await PDFDocument.create()
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

      const marginLeft = 50
      const colValueX = 250
      const marginTop = 60
      const fontSize = 11
      const lineHeight = 22

      let page = pdfDoc.addPage()
      let y = page.getSize().height - marginTop

      // Title
      page.drawText(`Formulario de Registro como Proveedor`, {
        x: marginLeft,
        y,
        size: 14,
        font: boldFont,
        color: rgb(0.1, 0.3, 0.6),
      })
      y -= lineHeight
      page.drawText(`Caso: ${caso}  |  Fecha: ${new Date().toLocaleDateString("es-CO")}`, {
        x: marginLeft,
        y,
        size: 9,
        font,
        color: rgb(0.5, 0.5, 0.5),
      })
      y -= lineHeight * 1.5

      for (const campo of plantilla) {
        if (y < marginTop + lineHeight * 2) {
          page = pdfDoc.addPage()
          y = page.getSize().height - marginTop
        }

        const lleno = llenos.find((l) => l.campo === campo.etiqueta)
        const reqConf = requiere_confirmacion.find((r) => r.campo === campo.etiqueta)
        const isFaltante = !lleno && !reqConf

        const valor = lleno?.valor ?? reqConf?.valor ?? ""
        const displayValor = isFaltante
          ? campo.obligatorio
            ? "[OBLIGATORIO — FALTANTE]"
            : "[FALTANTE]"
          : reqConf
            ? `${valor}  [REQUIERE CONFIRMACION]`
            : valor

        page.drawText(`${campo.etiqueta}:`, {
          x: marginLeft,
          y,
          size: fontSize,
          font: boldFont,
          color: rgb(0, 0, 0),
        })

        const truncated =
          displayValor.length > 55 ? displayValor.substring(0, 52) + "..." : displayValor

        page.drawText(truncated, {
          x: colValueX,
          y,
          size: fontSize,
          font,
          color: isFaltante ? rgb(0.75, 0.1, 0.1) : rgb(0, 0, 0),
        })

        if (reqConf) {
          y -= lineHeight * 0.8
          page.drawText(`  > ${reqConf.nota}`, {
            x: colValueX,
            y,
            size: 9,
            font,
            color: rgb(0.6, 0.4, 0),
          })
        }

        y -= lineHeight
      }

      const pdfBytes = await pdfDoc.save()
      const outPath = join(outDir, "formulario.pdf")
      await writeFile(outPath, pdfBytes)

      await writeLog(directory, caso, {
        herramienta: "proveedor_generar_formulario",
        ok: true,
        resumen: `formulario.pdf generado con ${llenos.length} campos llenos, ${faltantes.length} faltantes`,
      })

      return JSON.stringify({
        ok: true,
        data: { ruta: `out/${caso}/formulario.pdf`, formato: "pdf" },
      })
    }

    // ── PORTAL ────────────────────────────────────────────────────────────────
    if (formato === "portal") {
      const lines: string[] = [
        `# Valores para portal web — ${caso}`,
        "",
        `> Formato portal no implementado. Copiar estos valores manualmente en el portal.`,
        "",
        "| Campo | Valor | Nota |",
        "|-------|-------|------|",
      ]

      for (const l of llenos) {
        lines.push(`| ${l.campo} | ${l.valor} | — |`)
      }
      for (const r of requiere_confirmacion) {
        lines.push(`| ${r.campo} | ${r.valor} | ⚠ ${r.nota} |`)
      }
      for (const f of faltantes) {
        lines.push(`| ${f} | — | ❌ FALTANTE |`)
      }

      lines.push("", `_Generado: ${new Date().toISOString()}_`)
      await writeFile(join(outDir, "valores-portal.md"), lines.join("\n"), "utf8")

      await writeLog(directory, caso, {
        herramienta: "proveedor_generar_formulario",
        ok: true,
        resumen: "formato portal no soportado — se generó valores-portal.md",
      })

      return JSON.stringify({
        ok: true,
        data: {
          ruta: `out/${caso}/valores-portal.md`,
          formato: "portal",
          advertencia:
            "Formato portal no implementado. Valores disponibles en valores-portal.md para copia manual.",
        },
      })
    }

    return JSON.stringify({ ok: false, error: `Formato desconocido: ${formato}` })
  },
}

// ─── Tool 4: armar_paquete ────────────────────────────────────────────────────

export const armar_paquete = {
  description:
    "Crea el paquete para firma: copia el formulario, adjunta los soportes disponibles y genera el checklist y borrador de correo en out/<caso>/paquete/",
  args: {
    caso: z.string().describe("Nombre del caso"),
  },
  async execute(
    args: { caso: string },
    ctx: { directory: string; sessionId: string }
  ): Promise<string> {
    const { caso } = args
    const { directory } = ctx

    const solResult = await readJson<Solicitud>(
      join(directory, "fixtures", "reto-01", "casos", caso, "solicitud.json")
    )
    if (!solResult.ok) return JSON.stringify({ ok: false, error: solResult.error })
    const solicitud = solResult.data

    const sopExigidosResult = await readJson<string[]>(
      join(directory, "fixtures", "reto-01", "casos", caso, "soportes-exigidos.json")
    )
    if (!sopExigidosResult.ok)
      return JSON.stringify({ ok: false, error: sopExigidosResult.error })
    const soportesExigidos = sopExigidosResult.data

    const sopIndexResult = await readJson<SoporteIndexItem[]>(
      join(directory, "fixtures", "reto-01", "repositorio", "soportes", "index.json")
    )
    if (!sopIndexResult.ok)
      return JSON.stringify({ ok: false, error: sopIndexResult.error })
    const sopIndex = sopIndexResult.data

    const paqueteDir = join(directory, "out", caso, "paquete")
    await ensureDir(paqueteDir)

    // Find the formulario
    let formularioFilename: string | undefined
    let formularioSrc: string | undefined
    let formularioEsPortal = false

    for (const ext of ["xlsx", "pdf"]) {
      const candidate = join(directory, "out", caso, `formulario.${ext}`)
      if (await fileExists(candidate)) {
        formularioFilename = `formulario.${ext}`
        formularioSrc = candidate
        break
      }
    }

    if (!formularioSrc) {
      const portalFile = join(directory, "out", caso, "valores-portal.md")
      if (await fileExists(portalFile)) {
        formularioFilename = "valores-portal.md"
        formularioSrc = portalFile
        formularioEsPortal = true
      }
    }

    if (formularioSrc && formularioFilename) {
      await copyFile(formularioSrc, join(paqueteDir, formularioFilename))
    }

    // Process soportes
    const now = new Date()
    const presentes: string[] = []
    const vencidos: string[] = []
    const ausentes: string[] = []

    for (const tipo of soportesExigidos) {
      const item = sopIndex.find((s) => s.tipo === tipo)
      if (!item) {
        ausentes.push(tipo)
        continue
      }
      if (item.vigencia_hasta) {
        const expiry = new Date(item.vigencia_hasta)
        if (expiry < now) {
          vencidos.push(`${tipo} (venció ${item.vigencia_hasta})`)
          continue
        }
      }
      const srcFile = join(
        directory,
        "fixtures",
        "reto-01",
        "repositorio",
        "soportes",
        item.archivo
      )
      if (await fileExists(srcFile)) {
        await copyFile(srcFile, join(paqueteDir, item.archivo))
        presentes.push(tipo)
      } else {
        ausentes.push(`${tipo} (archivo no encontrado: ${item.archivo})`)
      }
    }

    const listo_para_firma = vencidos.length === 0 && ausentes.length === 0

    // Checklist
    const checklistLines: string[] = [
      `# Checklist del paquete — ${caso}`,
      `_Generado: ${new Date().toISOString()}_`,
      "",
      "## Formulario",
    ]
    if (formularioFilename) {
      checklistLines.push(
        `- [x] ${formularioFilename}${formularioEsPortal ? " *(portal — copia manual requerida)*" : ""}`
      )
    } else {
      checklistLines.push("- [ ] formulario — **NO GENERADO** (ejecutar proveedor_generar_formulario)")
    }

    checklistLines.push("", "## Soportes")
    for (const p of presentes) {
      checklistLines.push(`- [x] ${p} — vigente`)
    }
    for (const v of vencidos) {
      checklistLines.push(`- [ ] ${v} — **VENCIDO**`)
    }
    for (const a of ausentes) {
      checklistLines.push(`- [ ] ${a} — **AUSENTE**`)
    }

    checklistLines.push("", "## Estado")
    if (listo_para_firma) {
      checklistLines.push("**listo_para_firma: SÍ**")
    } else {
      const motivos: string[] = []
      if (vencidos.length > 0) motivos.push(`soporte(s) vencido(s): ${vencidos.join(", ")}`)
      if (ausentes.length > 0) motivos.push(`soporte(s) ausente(s): ${ausentes.join(", ")}`)
      checklistLines.push(`**listo_para_firma: NO** — motivo: ${motivos.join("; ")}`)
    }

    await writeFile(join(paqueteDir, "checklist.md"), checklistLines.join("\n"), "utf8")

    // Borrador correo (RN2: sin datos bancarios)
    const borradorLines: string[] = [
      "# Borrador de correo",
      "",
      `**Para:** ${solicitud.de}`,
      `**De:** Periferia IT Group S.A.S. <recepcion@periferia-ficticia.com>`,
      `**Asunto:** RE: ${solicitud.asunto}`,
      "",
      `Estimados señores de ${solicitud.cliente},`,
      "",
      "Por medio del presente mensaje, adjuntamos la documentación requerida para el proceso de registro de Periferia IT Group S.A.S. como proveedor en su sistema.",
      "",
      "**Documentos adjuntos:**",
    ]

    if (formularioFilename) {
      borradorLines.push(`- ${formularioFilename}`)
    }
    for (const p of presentes) {
      const item = sopIndex.find((s) => s.tipo === p)
      if (item) borradorLines.push(`- ${item.descripcion} (${item.archivo})`)
    }

    if (vencidos.length > 0 || ausentes.length > 0) {
      borradorLines.push(
        "",
        "**Nota:** Los siguientes documentos requieren actualización antes del envío definitivo:"
      )
      for (const v of vencidos) borradorLines.push(`- ${v}`)
      for (const a of ausentes) borradorLines.push(`- ${a}`)
    }

    borradorLines.push(
      "",
      "Quedamos atentos a cualquier consulta.",
      "",
      "Cordialmente,",
      "",
      "**Camila Ortiz Vélez**",
      "Analista Administrativa — Periferia IT Group S.A.S.",
      "facturacion@periferia-ficticia.com | +57 604 555 0102"
    )

    await writeFile(
      join(paqueteDir, "borrador-correo.md"),
      borradorLines.join("\n"),
      "utf8"
    )

    await writeLog(directory, caso, {
      herramienta: "proveedor_armar_paquete",
      ok: true,
      resumen: `paquete armado — ${presentes.length} soportes presentes, ${vencidos.length} vencidos, ${ausentes.length} ausentes — listo_para_firma: ${listo_para_firma}`,
    })

    return JSON.stringify({
      ok: true,
      data: {
        ruta: `out/${caso}/paquete`,
        listo_para_firma,
        checklist: { presentes, vencidos, ausentes },
      },
    })
  },
}

// ─── Tool 5: simular_envio ────────────────────────────────────────────────────

export const simular_envio = {
  description:
    "Simula el envío del paquete al cliente escribiendo ENVIO-SIMULADO.md. REQUIERE confirmación explícita del usuario (confirmado: true); si es false retorna error",
  args: {
    caso: z.string().describe("Nombre del caso"),
    confirmado: z
      .boolean()
      .describe(
        "true solo si el usuario confirmó explícitamente en el turno anterior; false retorna error"
      ),
  },
  async execute(
    args: { caso: string; confirmado: boolean },
    ctx: { directory: string; sessionId: string }
  ): Promise<string> {
    const { caso, confirmado } = args
    const { directory } = ctx

    if (!confirmado) {
      return JSON.stringify({
        ok: false,
        error:
          "requiere confirmación explícita del usuario — no se ejecutó el envío simulado",
      })
    }

    const outDir = join(directory, "out", caso)
    await ensureDir(outDir)

    const paqueteDir = join(outDir, "paquete")
    const paqueteExists = await fileExists(paqueteDir)

    const lines: string[] = [
      `# ENVÍO SIMULADO — ${caso}`,
      "",
      `**Fecha:** ${new Date().toISOString()}`,
      `**Estado:** SIMULADO (no se envió nada real)`,
      "",
      paqueteExists
        ? `El paquete en \`out/${caso}/paquete/\` fue marcado como listo para envío.`
        : `Advertencia: el paquete aún no ha sido armado (proveedor_armar_paquete no fue ejecutado).`,
      "",
      "---",
      "_Este archivo confirma que el agente recibió confirmación humana explícita para proceder con el envío._",
    ]

    const outPath = join(outDir, "ENVIO-SIMULADO.md")
    await writeFile(outPath, lines.join("\n"), "utf8")

    await writeLog(directory, caso, {
      herramienta: "proveedor_simular_envio",
      ok: true,
      resumen: "envío simulado — confirmado por el usuario",
    })

    return JSON.stringify({
      ok: true,
      data: { ruta: `out/${caso}/ENVIO-SIMULADO.md` },
    })
  },
}
