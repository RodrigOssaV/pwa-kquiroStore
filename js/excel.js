// Generación e importación de Excel con SheetJS (global `XLSX`, cargado desde CDN en index.html).
//
// FORMATO CRÍTICO (lo importa la app de escritorio):
//   Hoja única "productos"; fila 1: producto | cantidad | precio | codigo_barras | fecha_registro
//   producto (texto, MAYÚSCULAS) · cantidad (número entero) · precio (número entero CLP)
//   codigo_barras (texto, conserva ceros) · fecha_registro (texto "AAAA-MM-DD HH:mm")
//   Una fila por producto, sin filas vacías, sin totales, sin fórmulas, sin celdas combinadas.

import { consolidate, normalizeName, normalizeCode, normalizeHeader, parseIntCLP, formatDateTime } from "./util.js";

export const SHEET_NAME = "productos";
export const HEADERS = ["producto", "cantidad", "precio", "codigo_barras", "fecha_registro"];

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function lib(X) {
  const x = X || globalThis.XLSX;
  if (!x) throw new Error("No se cargó la librería de Excel. Abre la app con internet una vez para guardarla.");
  return x;
}

const textCell = (v) => ({ t: "s", v: String(v), z: "@" });
const numCell = (v) => ({ t: "n", v, z: "0" });

/**
 * Construye el workbook. Las celdas se crean a mano para garantizar el tipo
 * (texto vs. número) sin depender de conversiones automáticas.
 */
export function buildWorkbook(items, X) {
  const XLSX = lib(X);
  const rows = consolidate(items)
    .map((it) => ({
      producto: normalizeName(it.name),
      cantidad: Math.max(0, Math.trunc(Number(it.qty) || 0)),
      precio: Math.max(0, Math.trunc(Number(it.price) || 0)),
      codigo_barras: normalizeCode(it.code),
      fecha_registro: formatDateTime(it.createdAt || Date.now()),
    }))
    .filter((r) => r.producto); // nunca filas con producto vacío

  const ws = {};
  HEADERS.forEach((h, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { t: "s", v: h };
  });
  rows.forEach((row, i) => {
    const r = i + 1;
    ws[XLSX.utils.encode_cell({ r, c: 0 })] = { t: "s", v: row.producto };
    ws[XLSX.utils.encode_cell({ r, c: 1 })] = numCell(row.cantidad);
    ws[XLSX.utils.encode_cell({ r, c: 2 })] = numCell(row.precio);
    // Celda de texto explícita: sin esto Excel mostraría 7.80161E+12 o perdería ceros.
    // Si no hay código la celda se omite (queda vacía).
    if (row.codigo_barras) ws[XLSX.utils.encode_cell({ r, c: 3 })] = textCell(row.codigo_barras);
    ws[XLSX.utils.encode_cell({ r, c: 4 })] = { t: "s", v: row.fecha_registro };
  });
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: HEADERS.length - 1 } });
  ws["!cols"] = [{ wch: 34 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 17 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET_NAME);
  return { wb, rows };
}

/** Devuelve { data: ArrayBuffer, rows, units, total } listo para guardar/compartir. */
export function exportItems(items, X) {
  const XLSX = lib(X);
  const { wb, rows } = buildWorkbook(items, XLSX);
  // bookSST: textos en sharedStrings.xml (t="s"), igual que los guarda Excel; lo leen todos los lectores.
  const data = XLSX.write(wb, { bookType: "xlsx", type: "array", compression: true, bookSST: true });
  const units = rows.reduce((a, r) => a + r.cantidad, 0);
  const total = rows.reduce((a, r) => a + r.cantidad * r.precio, 0);
  return { data, rows: rows.length, units, total };
}

export function makeFile(data, filename) {
  return new File([data], filename, { type: XLSX_MIME });
}

/**
 * Lee un .xlsx con el mismo formato y devuelve entradas de catálogo { code, name, price }.
 * Ignora "cantidad". Filas sin código o sin nombre se cuentan como omitidas.
 */
export function parseCatalog(arrayBuffer, X) {
  const XLSX = lib(X);
  const wb = XLSX.read(arrayBuffer, { type: "array", raw: false, cellText: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("El archivo no tiene hojas.");
  // blankrows: true para que el índice de fila coincida con la hoja (lo usa codeAt).
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "", blankrows: true });
  if (!matrix.length) throw new Error("La hoja está vacía.");

  const headers = matrix[0].map(normalizeHeader);
  const col = (name) => headers.indexOf(name);
  const cProd = col("producto");
  const cPrice = col("precio");
  const cCode = col("codigo_barras");
  if (cProd < 0 || cPrice < 0 || cCode < 0) {
    throw new Error('Faltan columnas. Se necesitan "producto", "precio" y "codigo_barras" en la fila 1.');
  }

  // Para el código preferimos el texto mostrado (w) cuando la celda es numérica,
  // así no aparece en notación científica.
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const codeAt = (rowIdx, fallback) => {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r + rowIdx, c: range.s.c + cCode })];
    if (!cell) return "";
    if (cell.t === "n") return Number.isSafeInteger(cell.v) ? String(cell.v) : normalizeCode(cell.w ?? fallback);
    return normalizeCode(cell.v);
  };

  const entries = new Map();
  let skipped = 0;
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row || row.every((v) => String(v ?? "").trim() === "")) continue;
    const name = normalizeName(row[cProd]);
    const code = codeAt(i, row[cCode]);
    const price = parseIntCLP(row[cPrice]);
    if (!name || !code) {
      skipped++;
      continue;
    }
    entries.set(code, { code, name, price: Number.isNaN(price) ? 0 : price });
  }
  return { entries: [...entries.values()], skipped };
}
