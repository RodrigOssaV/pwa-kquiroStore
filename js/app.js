import * as db from "./db.js";
import { createScanner, unlockAudio, beep, vibrate } from "./scanner.js";
import { exportItems, makeFile, parseCatalog } from "./excel.js";
import {
  formatCLP, formatInt, formatDateTime, exportFileName, normalizeName, normalizeCode,
  parseIntCLP, uid, findSameProduct, totals, escapeHtml,
} from "./util.js";

/* =========================================================================
   Estado
   ========================================================================= */

const state = {
  items: [],               // lista actual
  catalog: new Map(),      // code -> { code, name, price, updatedAt }
  exports: [],             // historial (sin el binario)
  settings: { fastMode: false, sound: true },
  lastExportAt: 0,
  view: "lista",
  form: null,              // { mode: "new"|"edit", code, editId, from }
  persisted: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const scanner = createScanner("reader");

/* =========================================================================
   Arranque
   ========================================================================= */

async function init() {
  registerServiceWorker();
  bindEvents();

  try {
    const [items, catalog, exportsList, settings, lastExportAt] = await Promise.all([
      db.getAll("items"),
      db.getAll("catalog"),
      db.getAll("exports"),
      db.getMeta("settings", null),
      db.getMeta("lastExportAt", 0),
    ]);
    state.items = items;
    state.catalog = new Map(catalog.map((c) => [c.code, c]));
    state.exports = exportsList.map(stripData);
    if (settings) state.settings = { ...state.settings, ...settings };
    state.lastExportAt = lastExportAt || 0;
  } catch (err) {
    console.error(err);
    toast("No se pudo abrir el almacenamiento local: " + (err?.message || err), true);
  }

  $("#opt-fast").checked = state.settings.fastMode;
  $("#opt-sound").checked = state.settings.sound;

  db.requestPersistence().then((ok) => {
    state.persisted = ok;
    renderExports();
  });

  updateOnlineBadge();
  route();
  renderAll();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((err) => console.warn("SW:", err));
  });
}

const stripData = ({ data, ...rest }) => rest;

/* =========================================================================
   Navegación (hash)
   ========================================================================= */

const VIEWS = ["lista", "escanear", "catalogo", "exportaciones"];

function route() {
  const name = location.hash.replace("#", "");
  showView(VIEWS.includes(name) ? name : "lista");
}

function go(view) {
  if (location.hash === "#" + view) showView(view);
  else location.hash = view;
}

function showView(view) {
  const prev = state.view;
  state.view = view;
  for (const el of $$(".view")) el.hidden = el.dataset.view !== view;
  for (const tab of $$(".tab")) {
    if (tab.dataset.tab === view) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  // Al salir de Escanear se libera la cámara y se descarta la ficha abierta.
  if (prev === "escanear" && view !== "escanear") {
    scanner.stop();
    state.form = null;
    setScanMode("idle");
  }
  window.scrollTo(0, 0);
}

/* =========================================================================
   Eventos
   ========================================================================= */

function bindEvents() {
  window.addEventListener("hashchange", route);
  window.addEventListener("online", updateOnlineBadge);
  window.addEventListener("offline", updateOnlineBadge);

  // Si la app pasa a segundo plano con la cámara abierta, se libera.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && scanner.running) {
      scanner.stop();
      if (!state.form) setScanMode("idle");
    }
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    switch (action) {
      case "scan-now": go("escanear"); startCamera(); break;
      case "start-camera": startCamera(); break;
      case "stop-camera": scanner.stop(); setScanMode("idle"); break;
      case "manual-code": askManualCode(); break;
      case "no-code": scanner.stop(); openForm({ code: "" }); break;
      case "cancel-form": closeForm(); break;
      case "edit-item": editItem(id); break;
      case "delete-item": deleteItem(id); break;
      case "edit-catalog": editCatalog(id); break;
      case "delete-catalog": deleteCatalog(id); break;
      case "export": exportNow(); break;
      case "redownload": redownload(Number(id)); break;
      case "delete-export": deleteExport(Number(id)); break;
    }
  });

  $("#opt-fast").addEventListener("change", (e) => saveSettings({ fastMode: e.target.checked }));
  $("#opt-sound").addEventListener("change", (e) => {
    if (e.target.checked) unlockAudio();
    saveSettings({ sound: e.target.checked });
  });

  $("#list-search").addEventListener("input", renderList);
  $("#catalog-search").addEventListener("input", renderCatalog);
  $("#catalog-file").addEventListener("change", importCatalog);

  // Ficha
  const form = $("#scan-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveForm();
  });
  form.addEventListener("click", (e) => {
    const step = e.target.closest("[data-step]");
    if (!step) return;
    const qty = $("#f-qty");
    const current = parseIntCLP(qty.value);
    const next = Math.max(1, (Number.isNaN(current) ? 0 : current) + Number(step.dataset.step));
    qty.value = String(next);
    updateSubtotal();
  });
  $("#f-qty").addEventListener("input", updateSubtotal);
  $("#f-price").addEventListener("input", updateSubtotal);
  // "Siguiente" en el teclado del celular
  $("#f-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#f-qty").focus(); $("#f-qty").select(); }
  });
  $("#f-qty").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#f-price").focus(); $("#f-price").select(); }
  });
}

async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.setMeta("settings", state.settings);
}

function updateOnlineBadge() {
  $("#offline-badge").hidden = navigator.onLine;
}

/* =========================================================================
   Escáner
   ========================================================================= */

function setScanMode(mode) {
  $("#scan-idle").hidden = mode !== "idle";
  $("#scan-camera").hidden = mode !== "camera";
  $("#scan-form").hidden = mode !== "form";
  if (mode !== "camera") $("#fast-feed").hidden = true;
}

async function startCamera() {
  if (state.settings.sound) unlockAudio();
  state.form = null;
  $("#camera-error").hidden = true;
  setScanMode("camera");
  $("#reader-hint").textContent = state.settings.fastMode
    ? "Modo rápido: cada lectura suma +1"
    : "Apunta al código de barras";
  try {
    await scanner.start(onScanned);
  } catch (err) {
    setScanMode("idle");
    showCameraError(err);
  }
}

function showCameraError(err) {
  const help = {
    denied:
      "Activa el permiso de cámara para este sitio: en Android, toca el candado junto a la dirección → Permisos → Cámara. " +
      "En iPhone: Ajustes → Safari → Cámara → Permitir (o en la app instalada: Ajustes → KQuiro Scanner). " +
      "Mientras tanto puedes escribir el código a mano.",
    insecure: "Abre la app desde una dirección https://.",
    nocamera: "Puedes escribir el código a mano.",
    inuse: "Cierra otras apps que usen la cámara e inténtalo de nuevo.",
    nolib: "Conéctate a internet y recarga la app una vez para descargar el lector.",
    other: "Puedes escribir el código a mano.",
  };
  $("#camera-error-title").textContent =
    err.kind === "denied" ? "Permiso de cámara denegado" : "No se pudo usar la cámara";
  $("#camera-error-text").textContent = err.message;
  $("#camera-error-help").textContent = help[err.kind] || help.other;
  $("#camera-error").hidden = false;
}

function feedback() {
  vibrate(70);
  if (state.settings.sound) beep();
}

async function onScanned(code) {
  feedback();
  const known = state.catalog.get(code);

  if (state.settings.fastMode && known) {
    try {
      const item = await addQuantity({ code, name: known.name, price: known.price }, 1, "sum");
      const feed = $("#fast-feed");
      feed.hidden = false;
      feed.textContent = `+1 ${item.name} → ${formatInt(item.qty)} en total`;
    } catch (err) {
      toast("Error al guardar: " + err.message, true);
    }
    // Pausa breve para no contar el mismo producto dos veces.
    setTimeout(() => {
      if (state.view === "escanear" && !state.form) scanner.resume();
    }, 900);
    return;
  }

  await scanner.stop();
  openForm({ code });
}

async function askManualCode() {
  const result = await modal({
    title: "Escribir código",
    body: `
      <label class="field">
        <span class="field__label">Código de barras</span>
        <input class="input" name="code" type="text" inputmode="numeric" autocomplete="off"
               autocapitalize="characters" spellcheck="false" enterkeyhint="done" required>
        <span class="field__error" data-err="code"></span>
      </label>
      <p class="hint">Si el código tiene letras (Code 39 / Code 128), cambia el teclado a letras.</p>`,
    buttons: [
      { label: "Continuar", value: "ok", kind: "primary", submit: true },
      { label: "Cancelar", value: null },
    ],
    validate: (form) => (normalizeCode(form.code.value) ? null : { code: "Escribe el código." }),
  });
  if (!result || result.value !== "ok") return;
  const code = normalizeCode(result.form.code);
  await scanner.stop();
  if (state.view !== "escanear") go("escanear");
  // En modo rápido, un código conocido escrito a mano también suma +1 directo.
  if (state.settings.fastMode && state.catalog.has(code)) {
    const known = state.catalog.get(code);
    const item = await addQuantity({ code, name: known.name, price: known.price }, 1, "sum");
    toast(`+1 ${item.name} → ${formatInt(item.qty)} en total`);
    setScanMode("idle");
    return;
  }
  openForm({ code });
}

/* =========================================================================
   Ficha del producto
   ========================================================================= */

function openForm({ code = "", editId = null }) {
  const editing = editId ? state.items.find((i) => i.id === editId) : null;
  const known = code ? state.catalog.get(code) : null;
  const inList = editing || findSameProduct(state.items, { code, name: "" });
  const from = state.view;

  state.form = { mode: editing ? "edit" : "new", code: editing ? editing.code : code, editId, from };
  if (state.view !== "escanear") go("escanear");
  setScanMode("form");
  clearErrors();

  const codeShown = state.form.code || "Sin código";
  $("#f-code").textContent = codeShown;
  const tag = $("#f-tag");
  tag.className = "tag";
  if (editing) {
    tag.textContent = "Editando";
  } else if (!code) {
    tag.textContent = "Manual";
  } else if (known) {
    tag.textContent = "Conocido";
    tag.classList.add("tag--known");
  } else {
    tag.textContent = "Nuevo";
    tag.classList.add("tag--new");
  }

  const name = $("#f-name");
  const qty = $("#f-qty");
  const price = $("#f-price");

  if (editing) {
    name.value = editing.name;
    qty.value = String(editing.qty);
    price.value = String(editing.price);
  } else {
    const src = known || (code && inList) || null;
    name.value = src ? src.name : "";
    price.value = src ? String(src.price) : "";
    qty.value = "1";
  }

  const existing = $("#f-existing");
  if (!editing && code && inList) {
    existing.hidden = false;
    existing.textContent = `Ya hay ${formatInt(inList.qty)} en la lista. Al guardar podrás sumar o reemplazar.`;
  } else {
    existing.hidden = true;
  }

  updateSubtotal();

  // Foco: si ya conocemos el producto, directo a cantidad.
  requestAnimationFrame(() => {
    const target = (editing || known || (code && inList)) ? qty : name;
    target.focus();
    if (target === qty) qty.select();
  });
}

function closeForm() {
  // Si la ficha se abrió desde la pestaña Escanear, se vuelve a ella; si no, a la lista.
  const from = state.form?.from;
  state.form = null;
  setScanMode("idle");
  if (from !== "escanear") go("lista");
}

function updateSubtotal() {
  const q = parseIntCLP($("#f-qty").value);
  const p = parseIntCLP($("#f-price").value);
  $("#f-subtotal").textContent = formatCLP((Number.isNaN(q) ? 0 : q) * (Number.isNaN(p) ? 0 : p));
}

function clearErrors() {
  for (const id of ["name", "qty", "price"]) setFieldError(id, "");
}

function setFieldError(field, msg) {
  $(`#f-${field}-err`).textContent = msg;
  $(`#f-${field}`).setAttribute("aria-invalid", msg ? "true" : "false");
}

function readForm() {
  clearErrors();
  const name = normalizeName($("#f-name").value);
  const qtyRaw = $("#f-qty").value.trim();
  const priceRaw = $("#f-price").value.trim();
  const qty = /^\d+$/.test(qtyRaw) ? parseInt(qtyRaw, 10) : NaN;
  const price = parseIntCLP(priceRaw);

  let firstBad = null;
  if (!name) { setFieldError("name", "El nombre es obligatorio."); firstBad ||= "name"; }
  if (Number.isNaN(qty) || qty < 1) { setFieldError("qty", "La cantidad debe ser un número entero mayor o igual a 1."); firstBad ||= "qty"; }
  if (!priceRaw || Number.isNaN(price) || !/^[\d.\s$]+$/.test(priceRaw)) {
    setFieldError("price", "Ingresa el precio en pesos, sin decimales (ej. 1990)."); firstBad ||= "price";
  }
  if (firstBad) {
    $(`#f-${firstBad}`).focus();
    return null;
  }
  return { name, qty, price };
}

async function saveForm() {
  const f = state.form;
  if (!f) return;
  const data = readForm();
  if (!data) return;
  const code = f.code;

  try {
    if (f.mode === "edit") {
      const item = state.items.find((i) => i.id === f.editId);
      if (!item) throw new Error("El producto ya no existe en la lista.");
      const dup = findSameProduct(state.items, { code, name: data.name }, item.id);
      if (dup) {
        // Al renombrar un producto sin código puede coincidir con otro: se unen en una fila.
        const choice = await askSumOrReplace(dup, data.qty);
        if (!choice) return;
        await mergeInto(dup, data, choice);
        await removeItem(item.id);
      } else {
        await saveItem({ ...item, ...data, updatedAt: Date.now() });
      }
    } else {
      const existing = findSameProduct(state.items, { code, name: data.name });
      if (existing) {
        const choice = await askSumOrReplace(existing, data.qty);
        if (!choice) return;
        await mergeInto(existing, data, choice);
      } else {
        const now = Date.now();
        await saveItem({ id: uid(), code, ...data, createdAt: now, updatedAt: now });
      }
    }
    if (code) await saveCatalogEntry({ code, name: data.name, price: data.price });
  } catch (err) {
    console.error(err);
    toast("No se pudo guardar: " + err.message, true);
    return;
  }

  toast(`Guardado: ${data.name}`);
  state.form = null;
  setScanMode("idle");
  renderAll();
  go("lista");
}

async function askSumOrReplace(existing, qty) {
  const res = await modal({
    title: "Este producto ya está en la lista",
    body: `<p><strong>${escapeHtml(existing.name)}</strong> tiene <strong>${formatInt(existing.qty)}</strong> ${existing.qty === 1 ? "unidad" : "unidades"}.</p>
           <p>¿Sumar ${formatInt(qty)} a la cantidad existente o reemplazarla?</p>`,
    buttons: [
      { label: `Sumar (quedan ${formatInt(existing.qty + qty)})`, value: "sum", kind: "primary" },
      { label: `Reemplazar (quedan ${formatInt(qty)})`, value: "replace" },
      { label: "Cancelar", value: null, kind: "ghost" },
    ],
  });
  return res?.value || null;
}

async function mergeInto(existing, data, choice) {
  const qty = choice === "sum" ? existing.qty + data.qty : data.qty;
  await saveItem({ ...existing, name: data.name, price: data.price, qty, updatedAt: Date.now() });
}

/** Suma (o reemplaza) cantidad para un producto; crea la fila si no existe. */
async function addQuantity({ code, name, price }, qty, mode) {
  const existing = findSameProduct(state.items, { code, name });
  const now = Date.now();
  const item = existing
    ? { ...existing, qty: mode === "sum" ? existing.qty + qty : qty, updatedAt: now }
    : { id: uid(), code, name, price, qty, createdAt: now, updatedAt: now };
  await saveItem(item);
  renderAll();
  return item;
}

async function saveItem(item) {
  await db.put("items", item);
  const i = state.items.findIndex((x) => x.id === item.id);
  if (i >= 0) state.items[i] = item;
  else state.items.push(item);
}

async function removeItem(id) {
  await db.del("items", id);
  state.items = state.items.filter((x) => x.id !== id);
}

async function saveCatalogEntry({ code, name, price }) {
  const entry = { code, name, price, updatedAt: Date.now() };
  await db.put("catalog", entry);
  state.catalog.set(code, entry);
}

/* =========================================================================
   Lista
   ========================================================================= */

function editItem(id) {
  openForm({ editId: id });
}

async function deleteItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  const res = await modal({
    title: "Eliminar producto",
    body: `<p>¿Eliminar <strong>${escapeHtml(item.name)}</strong> (${formatInt(item.qty)} u.) de la lista?</p>
           <p class="hint">El producto seguirá en el catálogo.</p>`,
    buttons: [
      { label: "Eliminar", value: "yes", kind: "danger" },
      { label: "Cancelar", value: null },
    ],
  });
  if (res?.value !== "yes") return;
  await removeItem(id);
  renderAll();
  toast("Producto eliminado");
}

function matches(query, ...fields) {
  if (!query) return true;
  const q = normalizeName(query);
  return fields.some((f) => normalizeName(f).includes(q));
}

function unexportedCount() {
  return state.items.filter((i) => (i.updatedAt || 0) > state.lastExportAt).length;
}

function renderList() {
  const t = totals(state.items);
  $("#stat-distinct").textContent = formatInt(t.distinct);
  $("#stat-units").textContent = formatInt(t.units);
  $("#stat-value").textContent = formatCLP(t.value);

  const pending = unexportedCount();
  $("#unexported-banner").hidden = pending === 0;
  $("#unexported-text").textContent =
    pending === 1 ? "1 producto sin exportar" : `${formatInt(pending)} productos sin exportar`;
  const badge = $("#tab-badge");
  badge.hidden = pending === 0;
  badge.textContent = pending > 99 ? "99+" : String(pending);

  const q = $("#list-search").value.trim();
  const rows = state.items
    .filter((i) => matches(q, i.name, i.code))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  $("#list-items").innerHTML = rows
    .map(
      (i) => `
      <li class="card">
        <div class="card__top">
          <span class="card__name">${escapeHtml(i.name)}</span>
          <span class="card__sub">${formatCLP(i.qty * i.price)}</span>
        </div>
        <div class="card__meta">${i.code ? escapeHtml(i.code) : "Sin código"}</div>
        <div class="card__line"><span class="card__qty">${formatInt(i.qty)}</span> × ${formatCLP(i.price)}</div>
        <div class="card__actions">
          <button class="btn btn--icon" type="button" data-action="edit-item" data-id="${escapeHtml(i.id)}">Editar</button>
          <button class="btn btn--icon btn--ghost" type="button" data-action="delete-item" data-id="${escapeHtml(i.id)}">Eliminar</button>
        </div>
      </li>`
    )
    .join("");

  const empty = $("#list-empty");
  empty.hidden = rows.length > 0;
  empty.innerHTML = state.items.length
    ? "Ningún producto coincide con la búsqueda."
    : "Aún no hay productos.<br>Toca <strong>Escanear</strong> para empezar.";
}

/* =========================================================================
   Catálogo
   ========================================================================= */

function renderCatalog() {
  const q = $("#catalog-search").value.trim();
  const all = [...state.catalog.values()];
  const rows = all.filter((c) => matches(q, c.name, c.code)).sort((a, b) => a.name.localeCompare(b.name, "es"));
  $("#catalog-count").textContent = all.length ? `(${formatInt(all.length)})` : "";
  // Para catálogos grandes mostramos los primeros 300 resultados; la búsqueda filtra el resto.
  const shown = rows.slice(0, 300);
  $("#catalog-items").innerHTML =
    shown
      .map(
        (c) => `
      <li class="card">
        <div class="card__top">
          <span class="card__name">${escapeHtml(c.name)}</span>
          <span class="card__sub">${formatCLP(c.price)}</span>
        </div>
        <div class="card__meta">${escapeHtml(c.code)}</div>
        <div class="card__actions">
          <button class="btn btn--icon" type="button" data-action="edit-catalog" data-id="${escapeHtml(c.code)}">Editar</button>
          <button class="btn btn--icon btn--ghost" type="button" data-action="delete-catalog" data-id="${escapeHtml(c.code)}">Eliminar</button>
        </div>
      </li>`
      )
      .join("") +
    (rows.length > shown.length
      ? `<li class="hint">Mostrando ${shown.length} de ${formatInt(rows.length)}. Usa el buscador para encontrar más.</li>`
      : "");
  const empty = $("#catalog-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = all.length ? "Ningún producto coincide con la búsqueda." : "El catálogo está vacío.";
}

async function editCatalog(code) {
  const entry = state.catalog.get(code);
  if (!entry) return;
  const res = await modal({
    title: "Editar producto del catálogo",
    body: `
      <p class="card__meta">Código: ${escapeHtml(code)}</p>
      <label class="field">
        <span class="field__label">Nombre</span>
        <input class="input input--upper" name="name" type="text" autocomplete="off" autocapitalize="characters"
               spellcheck="false" value="${escapeHtml(entry.name)}">
        <span class="field__error" data-err="name"></span>
      </label>
      <label class="field">
        <span class="field__label">Precio (CLP)</span>
        <input class="input" name="price" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
               value="${escapeHtml(entry.price)}">
        <span class="field__error" data-err="price"></span>
      </label>`,
    buttons: [
      { label: "Guardar", value: "ok", kind: "primary", submit: true },
      { label: "Cancelar", value: null },
    ],
    validate: (form) => {
      const errs = {};
      if (!normalizeName(form.name.value)) errs.name = "El nombre es obligatorio.";
      if (Number.isNaN(parseIntCLP(form.price.value))) errs.price = "Ingresa un precio válido.";
      return Object.keys(errs).length ? errs : null;
    },
  });
  if (res?.value !== "ok") return;
  await saveCatalogEntry({ code, name: normalizeName(res.form.name), price: parseIntCLP(res.form.price) });
  renderCatalog();
  toast("Catálogo actualizado");
}

async function deleteCatalog(code) {
  const entry = state.catalog.get(code);
  if (!entry) return;
  const res = await modal({
    title: "Eliminar del catálogo",
    body: `<p>¿Eliminar <strong>${escapeHtml(entry.name)}</strong> del catálogo?</p>
           <p class="hint">No afecta a la lista actual. La próxima vez que lo escanees se pedirá nombre y precio.</p>`,
    buttons: [
      { label: "Eliminar", value: "yes", kind: "danger" },
      { label: "Cancelar", value: null },
    ],
  });
  if (res?.value !== "yes") return;
  await db.del("catalog", code);
  state.catalog.delete(code);
  renderCatalog();
  toast("Eliminado del catálogo");
}

async function importCatalog(e) {
  const input = e.target;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  let parsed;
  try {
    parsed = parseCatalog(await file.arrayBuffer());
  } catch (err) {
    toast("No se pudo leer el archivo: " + err.message, true);
    return;
  }
  const { entries, skipped } = parsed;
  if (!entries.length) {
    toast("El archivo no tiene productos con código de barras.", true);
    return;
  }
  const isNew = entries.filter((x) => !state.catalog.has(x.code)).length;
  const res = await modal({
    title: "Importar catálogo",
    body: `<p><strong>${formatInt(entries.length)}</strong> productos encontrados en <em>${escapeHtml(file.name)}</em>:</p>
           <p>• ${formatInt(isNew)} nuevos<br>• ${formatInt(entries.length - isNew)} actualizarán nombre y precio</p>
           ${skipped ? `<p class="hint">${formatInt(skipped)} filas sin código o sin nombre se omitirán.</p>` : ""}
           <p class="hint">La columna "cantidad" se ignora. La lista actual no cambia.</p>`,
    buttons: [
      { label: "Importar", value: "ok", kind: "primary" },
      { label: "Cancelar", value: null },
    ],
  });
  if (res?.value !== "ok") return;
  const now = Date.now();
  const rows = entries.map((x) => ({ ...x, updatedAt: now }));
  try {
    await db.putMany("catalog", rows);
  } catch (err) {
    toast("Error al importar: " + err.message, true);
    return;
  }
  for (const r of rows) state.catalog.set(r.code, r);
  renderCatalog();
  toast(`Catálogo importado: ${formatInt(rows.length)} productos`);
}

/* =========================================================================
   Exportar
   ========================================================================= */

/** Comparte el archivo (Web Share) o lo descarga. */
async function deliverFile(file) {
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
      return "shared";
    }
  } catch (err) {
    if (err?.name === "AbortError") return "cancelled";
    console.warn("share:", err); // p. ej. NotAllowedError → descarga
  }
  download(file);
  return "downloaded";
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportNow() {
  if (!state.items.length) {
    toast("La lista está vacía. Escanea productos antes de exportar.", true);
    return;
  }
  // Todo lo anterior a navigator.share debe ser síncrono para no perder el "gesto del usuario" (Safari).
  let result;
  const now = Date.now();
  const filename = exportFileName(now);
  try {
    result = exportItems(state.items);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const file = makeFile(result.data, filename);
  const how = await deliverFile(file);
  if (how === "cancelled") {
    toast("Exportación cancelada. No se marcó como exportado.");
    return;
  }

  const record = { date: now, filename, rows: result.rows, units: result.units, total: result.total, data: result.data };
  try {
    const id = await db.put("exports", record);
    state.exports.push(stripData({ ...record, id }));
    state.lastExportAt = now;
    await db.setMeta("lastExportAt", now);
  } catch (err) {
    console.error(err);
    toast("El archivo se generó, pero no se pudo guardar en el historial.", true);
  }
  renderAll();

  const res = await modal({
    title: how === "shared" ? "Excel compartido" : "Excel descargado",
    body: `<p><strong>${escapeHtml(filename)}</strong></p>
           <p>${formatInt(result.rows)} productos · ${formatInt(result.units)} unidades · ${formatCLP(result.total)}</p>
           <p>¿Vaciar la lista actual para empezar un nuevo registro?</p>
           <p class="hint">El catálogo no se borra. El archivo queda en el historial de exportaciones.</p>`,
    buttons: [
      { label: "Vaciar lista", value: "clear", kind: "danger" },
      { label: "Mantener la lista", value: null },
    ],
  });
  if (res?.value === "clear") {
    await db.clear("items");
    state.items = [];
    renderAll();
    toast("Lista vaciada");
  }
}

async function redownload(id) {
  const rec = await db.get("exports", id);
  if (!rec?.data) {
    toast("No se encontró el archivo.", true);
    return;
  }
  const how = await deliverFile(makeFile(rec.data, rec.filename));
  if (how === "downloaded") toast("Descargado: " + rec.filename);
}

async function deleteExport(id) {
  const rec = state.exports.find((e) => e.id === id);
  if (!rec) return;
  const res = await modal({
    title: "Eliminar del historial",
    body: `<p>¿Eliminar <strong>${escapeHtml(rec.filename)}</strong> del historial?</p>`,
    buttons: [
      { label: "Eliminar", value: "yes", kind: "danger" },
      { label: "Cancelar", value: null },
    ],
  });
  if (res?.value !== "yes") return;
  await db.del("exports", id);
  state.exports = state.exports.filter((e) => e.id !== id);
  renderExports();
}

function renderExports() {
  const t = totals(state.items);
  const pending = unexportedCount();
  $("#export-summary").textContent = state.items.length
    ? `Lista actual: ${formatInt(t.distinct)} productos, ${formatInt(t.units)} unidades, ${formatCLP(t.value)}.` +
      (pending ? ` ${formatInt(pending)} con cambios sin exportar.` : " Todo exportado.")
    : "La lista actual está vacía.";

  const st = $("#storage-status");
  if (state.persisted === true) st.textContent = "✓ Almacenamiento persistente activado: el navegador no borrará los datos.";
  else if (state.persisted === false)
    st.textContent = "Almacenamiento no persistente: instala la app en la pantalla de inicio para protegerlos mejor, y exporta con frecuencia.";
  else st.textContent = "";

  const rows = [...state.exports].sort((a, b) => b.date - a.date);
  $("#export-items").innerHTML = rows
    .map(
      (e) => `
      <li class="card">
        <div class="card__top">
          <span class="card__name">${formatDateTime(e.date)}</span>
          <span class="card__sub">${formatCLP(e.total)}</span>
        </div>
        <div class="card__meta">${escapeHtml(e.filename)}</div>
        <div class="card__line">${formatInt(e.rows)} filas · ${formatInt(e.units)} unidades</div>
        <div class="card__actions">
          <button class="btn btn--icon" type="button" data-action="redownload" data-id="${e.id}">Descargar</button>
          <button class="btn btn--icon btn--ghost" type="button" data-action="delete-export" data-id="${e.id}">Eliminar</button>
        </div>
      </li>`
    )
    .join("");
  $("#export-empty").hidden = rows.length > 0;
}

function renderAll() {
  renderList();
  renderCatalog();
  renderExports();
}

/* =========================================================================
   Modal y toast
   ========================================================================= */

let modalResolve = null;

/**
 * Abre un modal. Devuelve una promesa con { value, form } o null si se cierra.
 * `validate(formElement)` puede devolver { campo: "mensaje" } para impedir el cierre.
 */
function modal({ title, body, buttons, validate }) {
  if (modalResolve) modalResolve(null);
  const root = $("#modal");
  const formEl = $("#modal-body");
  const btns = $("#modal-buttons");
  $("#modal-title").textContent = title;
  formEl.innerHTML = body;
  btns.innerHTML = "";
  btns.className = "modal__buttons";

  const previousFocus = document.activeElement;

  return new Promise((resolve) => {
    const finish = (value) => {
      root.hidden = true;
      formEl.onsubmit = null;
      document.removeEventListener("keydown", onKey);
      modalResolve = null;
      const data = Object.fromEntries(new FormData(formEl).entries());
      previousFocus?.focus?.({ preventScroll: true });
      resolve(value === null ? null : { value, form: data });
    };
    const attempt = (value) => {
      if (value !== null && validate) {
        for (const el of $$("[data-err]", formEl)) el.textContent = "";
        const errs = validate(formEl);
        if (errs) {
          for (const [k, msg] of Object.entries(errs)) {
            const el = $(`[data-err="${k}"]`, formEl);
            if (el) el.textContent = msg;
          }
          const firstBad = formEl.elements[Object.keys(errs)[0]];
          firstBad?.focus();
          return;
        }
      }
      finish(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") finish(null);
    };

    for (const b of buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "btn btn--large" + (b.kind ? ` btn--${b.kind}` : "");
      el.textContent = b.label;
      el.addEventListener("click", () => attempt(b.value));
      btns.appendChild(el);
    }
    const submitBtn = buttons.find((b) => b.submit);
    formEl.onsubmit = (e) => {
      e.preventDefault();
      if (submitBtn) attempt(submitBtn.value);
    };
    root.querySelector("[data-modal-dismiss]").onclick = () => finish(null);
    document.addEventListener("keydown", onKey);
    modalResolve = resolve;
    root.hidden = false;

    requestAnimationFrame(() => {
      const firstInput = formEl.querySelector("input");
      if (firstInput) {
        firstInput.focus();
        firstInput.select?.();
      } else {
        btns.querySelector("button")?.focus();
      }
    });
  });
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("toast--error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2200);
}

init();
