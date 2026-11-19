# Conocimiento del proceso: Registro como Proveedor

## ¿Qué es el proceso?

Cuando un cliente de Periferia IT Group requiere crear a Periferia como proveedor en su sistema interno, envía por correo un formulario de registro en alguno de estos formatos: Excel (.xlsx), PDF o un enlace a un portal web. La analista administrativa debe completar ese formulario con los datos de Periferia y adjuntar los documentos de soporte exigidos.

Este proceso ocurre entre 8 y 12 veces al mes, con clientes en Colombia, Ecuador, Perú, Panamá y Honduras.

---

## Repositorio maestro

Todos los datos de Periferia se encuentran en `fixtures/reto-01/repositorio/maestro.json`. Las claves son en `snake_case`. Los campos anidados se acceden con notación de punto, por ejemplo `representante_legal.nombre` o `banco.numero_cuenta`.

---

## Reglas por país — Identificador tributario (RN1)

El identificador tributario de cada país tiene un nombre diferente:

| País | Código | Nombre local | Situación de Periferia |
|------|--------|--------------|------------------------|
| Colombia | CO | NIT | Periferia tiene NIT colombiano |
| Ecuador | EC | RUC | Periferia no tiene RUC. Se llena con el NIT y se marca `requiere_confirmacion` con nota "identificador extranjero" |
| Perú | PE | RUC | Igual que Ecuador |
| Panamá | PA | RUC | Igual que Ecuador |
| Honduras | HN | RTN | Igual que Ecuador — se llena con NIT, se marca `requiere_confirmacion` con nota "identificador extranjero" |

Cuando un campo del formulario es "RUC", "RTN", "Identificación tributaria", "NIF" u otros sinónimos, se resuelve a través del glosario (`fixtures/reto-01/glosario-campos.json`).

---

## Glosario de sinónimos

El archivo `fixtures/reto-01/glosario-campos.json` mapea etiquetas que usan los clientes a claves del maestro. Por ejemplo:
- "Razón social" → `razon_social`
- "Nombre de la empresa" → `razon_social`
- "RUC" → `nit`
- "RTN" → `nit`
- "Domicilio fiscal" → `direccion`

Si un campo no está en el glosario, se intenta encontrar su clave directamente en el maestro.

---

## Estados de un campo mapeado

| Estado | Significado |
|--------|-------------|
| `lleno` | El campo tiene valor en el maestro y no tiene restricciones. |
| `faltante` | El campo no existe en el maestro ni en el glosario. El agente no inventa el valor; lo reporta como faltante. |
| `requiere_confirmacion` | El campo tiene valor pero hay una condición que un humano debe verificar (ej. identificador tributario extranjero, mapeo con baja confianza). Se llena con el mejor valor disponible y se señala claramente. |

---

## Soportes de Periferia

Los documentos de soporte se encuentran en `fixtures/reto-01/repositorio/soportes/`. El índice es `index.json` y cada soporte tiene:
- `tipo`: identificador del tipo de documento
- `archivo`: nombre del archivo en la carpeta soportes/
- `vigencia_hasta`: fecha de vencimiento (null = sin vencimiento)
- `pais_emisor`: país de emisión

### Tipos disponibles
- `camara_comercio` — Certificado de existencia y representación legal (vigencia 30 días)
- `rut` — Registro Único Tributario (sin vencimiento)
- `certificacion_bancaria` — Certificación de cuenta bancaria
- `parafiscales` — Certificación de pago de aportes parafiscales
- `estados_financieros` — Estados financieros auditados
- `certificado_iso_9001` — Certificado ISO 9001:2015

---

## Bloqueos de `listo_para_firma` (RN3)

El paquete se considera **NO listo** para firma del representante legal si:
- Algún soporte exigido está vencido (vigencia_hasta < fecha actual)
- Algún soporte exigido no está disponible en el repositorio (ausente)

**No bloquea:**
- Campos faltantes en el formulario (se incluyen en el checklist pero no impiden la firma)

---

## Datos bancarios (RN2)

Los datos bancarios (banco, tipo de cuenta, número de cuenta, titular, SWIFT) se incluyen en el formulario **solo si la plantilla del cliente los pide explícitamente**. Nunca se incluyen en el borrador de correo de envío.

---

## Proceso paso a paso

1. El cliente envía un correo con el formulario a rellenar.
2. La analista indica al agente el nombre del caso.
3. El agente lee la solicitud, mapea los campos, genera el formulario y arma el paquete.
4. La analista revisa los faltantes y los completa manualmente si puede.
5. El representante legal firma el formulario.
6. La analista envía el paquete firmado al cliente.

El agente automatiza los pasos 3 y parte del 4. Los pasos 5 y 6 siempre son humanos.

---

## Casos de prueba disponibles

| Caso | País | Cliente | Formato |
|------|------|---------|---------|
| `co-industrias-delta` | CO | Industrias Delta S.A.S. | xlsx (2 hojas) |
| `ec-corp-andina` | EC | Corporación Andina de Servicios S.A. | pdf |
| `hn-agroexport-sula` | HN | Agroexport Sula S. de R.L. | xlsx (1 hoja) |
| `pa-logistica-istmo` | PA | Logística del Istmo S.A. | portal (no implementado) |
