// Utilidades puras (sin DOM ni IndexedDB) para que sean fáciles de probar.

const clpFormatter = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" });
const intFormatter = new Intl.NumberFormat("es-CL");

export const formatCLP = (n) => clpFormatter.format(n || 0);
export const formatInt = (n) => intFormatter.format(n || 0);

/** Nombre de producto: MAYÚSCULAS, sin espacios al inicio/fin ni espacios dobles. */
export function normalizeName(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleUpperCase("es-CL");
}

/** Código de barras: solo se quitan espacios; se conserva como texto (ceros a la izquierda). */
export function normalizeCode(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, "").trim();
}

/**
 * Convierte un texto a entero ≥ 0. Acepta "1.990", "$ 1.990", "1990".
 * Devuelve NaN si no hay dígitos.
 */
export function parseIntCLP(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.round(value)) : NaN;
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  if (!digits) return NaN;
  return parseInt(digits, 10);
}

/** Normaliza un encabezado de Excel: minúsculas, sin tildes, sin espacios. */
export function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .trim();
}

const pad = (n) => String(n).padStart(2, "0");

/** "AAAA-MM-DD HH:mm" en hora local. */
export function formatDateTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** kquiro_productos_AAAA-MM-DD_HHmm.xlsx */
export function exportFileName(ts = Date.now()) {
  const d = new Date(ts);
  return `kquiro_productos_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Clave que identifica "el mismo producto" dentro de la lista:
 * por código si lo tiene; si no, por nombre normalizado.
 */
export function itemKey(item) {
  return item.code ? `c:${item.code}` : `n:${normalizeName(item.name)}`;
}

/** Busca en la lista un ítem que represente el mismo producto (excluyendo `exceptId`). */
export function findSameProduct(items, { code, name }, exceptId = null) {
  const key = itemKey({ code, name });
  return items.find((it) => it.id !== exceptId && itemKey(it) === key) || null;
}

/**
 * Consolida la lista en una fila por producto (suma cantidades).
 * La lista ya debería estar consolidada; esto es una protección extra antes de exportar.
 */
export function consolidate(items) {
  const map = new Map();
  for (const it of items) {
    const key = itemKey(it);
    const prev = map.get(key);
    if (prev) {
      prev.qty += it.qty;
      prev.createdAt = Math.min(prev.createdAt, it.createdAt);
      if ((it.updatedAt || 0) > (prev.updatedAt || 0)) {
        prev.price = it.price;
        prev.name = it.name;
        prev.updatedAt = it.updatedAt;
      }
    } else {
      map.set(key, { ...it });
    }
  }
  return [...map.values()];
}

export function totals(items) {
  let units = 0;
  let value = 0;
  for (const it of items) {
    units += it.qty;
    value += it.qty * it.price;
  }
  return { distinct: items.length, units, value };
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
