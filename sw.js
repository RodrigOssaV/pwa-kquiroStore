// Service worker de KQuiro Scanner.
// Guarda en caché la app y las librerías del CDN para funcionar 100% sin internet.
// Al publicar cambios, sube VERSION para que los teléfonos descarguen la nueva versión.

const VERSION = "v1.0.0";
const CACHE = `kquiro-scanner-${VERSION}`;

const LOCAL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/app.js",
  "./js/db.js",
  "./js/scanner.js",
  "./js/excel.js",
  "./js/util.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

// Deben coincidir EXACTAMENTE con las URLs de index.html.
const CDN_ASSETS = [
  "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
];

async function cacheCdn(cache, url) {
  // Primero con CORS (respuesta legible y sin el sobrecosto de cuota de las respuestas opacas);
  // si el CDN no lo permitiera, se guarda la respuesta opaca, que igual sirve para <script>.
  let res;
  try {
    res = await fetch(url, { mode: "cors", credentials: "omit", cache: "reload" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    res = await fetch(new Request(url, { mode: "no-cors", credentials: "omit" }));
  }
  await cache.put(url, res);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(LOCAL_ASSETS.map((u) => new Request(u, { cache: "reload" })));
      // Si falla una librería, la instalación falla y se reintenta en la próxima visita:
      // así nunca se queda una versión "instalada" que no funcione sin internet.
      await Promise.all(CDN_ASSETS.map((u) => cacheCdn(cache, u)));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("kquiro-scanner-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Navegación: siempre index.html desde caché (la app es de una sola página).
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cached = await caches.match("./index.html", { ignoreSearch: true });
        if (cached) return cached;
        return fetch(req);
      })()
    );
    return;
  }

  // Resto: caché primero; si no está, red (y se guarda si es del mismo origen o de un CDN conocido).
  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: url.origin === self.location.origin });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && (url.origin === self.location.origin || CDN_ASSETS.includes(req.url))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })()
  );
});
