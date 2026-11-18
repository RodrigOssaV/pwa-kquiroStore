// Genera los íconos PNG de la PWA sin dependencias:  node tools/make-icons.mjs
// Dibujo: fondo azul, tarjeta blanca con código de barras y línea de escaneo naranja.

import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(OUT, { recursive: true });

const BG = [11, 61, 145];
const CARD = [255, 255, 255];
const BAR = [13, 20, 32];
const SCAN = [228, 87, 46];

// Anchos de barras (unidades) alternando barra/espacio, empezando por barra.
const PATTERN = [2, 1, 1, 1, 3, 1, 1, 2, 2, 1, 1, 1, 3, 2, 1, 1, 2, 1, 1, 1, 3, 1, 2, 2, 1, 1, 2];

function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Color en coordenadas normalizadas 0..1. `inset` encoge el dibujo (para maskable). */
function shade(u, v, { rounded, scale }) {
  if (rounded && !roundRect(u, v, 0, 0, 1, 1, 0.22)) return null; // transparente
  // Coordenadas del contenido, centradas y escaladas.
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;

  // Línea de escaneo (sobresale de la tarjeta)
  if (Math.abs(y - 0.5) < 0.022 && x > 0.12 && x < 0.88) return SCAN;

  if (roundRect(x, y, 0.18, 0.27, 0.82, 0.73, 0.06)) {
    // Barras dentro de la tarjeta
    if (y > 0.34 && y < 0.66) {
      const total = PATTERN.reduce((a, b) => a + b, 0);
      const bx0 = 0.25, bx1 = 0.75;
      if (x >= bx0 && x < bx1) {
        let pos = ((x - bx0) / (bx1 - bx0)) * total;
        for (let i = 0; i < PATTERN.length; i++) {
          if (pos < PATTERN[i]) return i % 2 === 0 ? BAR : CARD;
          pos -= PATTERN[i];
        }
      }
    }
    return CARD;
  }
  return BG;
}

function render(size, opts) {
  const SS = 4; // supersampling para bordes suaves
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((pxl + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const i = (py * size + pxl) * 4;
      if (a) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, size, px);
}

// ---------- Codificador PNG mínimo (RGBA 8 bits) ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const files = {
  "icon-192.png": render(192, { rounded: true, scale: 1 }),
  "icon-512.png": render(512, { rounded: true, scale: 1 }),
  // Maskable: fondo completo y contenido dentro de la zona segura (círculo del 80 %).
  "icon-maskable-512.png": render(512, { rounded: false, scale: 0.78 }),
  // iOS aplica sus propias esquinas redondeadas y no admite transparencia.
  "apple-touch-icon.png": render(180, { rounded: false, scale: 0.92 }),
};
for (const [name, buf] of Object.entries(files)) {
  writeFileSync(join(OUT, name), buf);
  console.log("icons/" + name, buf.length, "bytes");
}
