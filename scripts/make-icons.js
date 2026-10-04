'use strict';

/**
 * Generates the tray and app icons as PNGs (no dependencies).
 * An open eye means "awake" (session active); a closed eye means "sleep allowed".
 *
 *   node scripts/make-icons.js
 *
 * Shapes are described in a unit square and rasterised with 4x4 supersampling,
 * so every size comes from the same geometry.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');

/* ---------------------------- PNG encoding ---------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba width*height*4 */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- shapes ------------------------------- */

// Each shape is (x, y) => boolean in the unit square.

/** Region between two mirrored parabolic lids: |y-cy| <= a * (1 - ((x-cx)/w)^2). */
const almond = (cx, cy, w, a) => (x, y) => {
  const u = (x - cx) / w;
  return Math.abs(u) <= 1 && Math.abs(y - cy) <= a * (1 - u * u);
};

const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

const capsule = (x1, y1, x2, y2, r) => (x, y) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2 <= r * r;
};

const union = (...shapes) => (x, y) => shapes.some((s) => s(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);
const inter = (a, b) => (x, y) => a(x, y) && b(x, y);

/** Open eye: almond outline plus a pupil. `t` is stroke thickness. */
function openEye(t) {
  const outline = minus(almond(0.5, 0.5, 0.44, 0.26), almond(0.5, 0.5, 0.44 - t * 1.4, 0.26 - t));
  return union(outline, disc(0.5, 0.5, 0.115 + t * 0.35));
}

/** A parabolic arc y = cy + a*(1-u^2) across width w, stroked with constant visual thickness t. */
const arcStroke = (cx, cy, w, a, t) => (x, y) => {
  const u = (x - cx) / w;
  if (Math.abs(u) > 1) return false;
  const slope = (-2 * a * u) / w;
  const distance = Math.abs(y - (cy + a * (1 - u * u))) / Math.sqrt(1 + slope * slope);
  return distance <= t / 2;
};

/** Closed eye: a downward-curving lid with three lashes. */
function closedEye(t) {
  const r = t / 2;
  return union(
    arcStroke(0.5, 0.32, 0.44, 0.22, t * 1.2),
    capsule(0.26, 0.55, 0.2, 0.67, r),
    capsule(0.5, 0.62, 0.5, 0.75, r),
    capsule(0.74, 0.55, 0.8, 0.67, r),
  );
}

/* ----------------------------- rasterising ---------------------------- */

const SS = 4; // supersampling per axis

function rasterise(size, shape, paint) {
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (shape((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size)) hits++;
        }
      }
      const coverage = hits / (SS * SS);
      const [r, g, b, a] = paint(px / size, py / size);
      const i = (py * size + px) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = Math.round(a * coverage);
    }
  }
  return pixels;
}

const black = () => [0, 0, 0, 255];
const write = (name, size, shape, paint = black) => {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, size, rasterise(size, shape, paint)));
  console.log(`wrote assets/${name}`);
};

/* ------------------------------ app icon ------------------------------ */

/** Rounded square, for the app icon background. */
const roundedSquare = (radius) => (x, y) => {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
};

function appIcon(size) {
  const eye = openEye(0.06);
  const shape = roundedSquare(0.22);
  const pixels = rasterise(size, shape, (u, v) => {
    // Diagonal gradient, indigo -> teal.
    const t = (u + v) / 2;
    return [Math.round(79 + (20 - 79) * t), Math.round(70 + (170 - 70) * t), Math.round(229 + (180 - 229) * t), 255];
  });
  // White eye on top, composited with the same supersampling.
  const eyePixels = rasterise(size, eye, () => [255, 255, 255, 255]);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = eyePixels[i + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * (1 - a) + 255 * a);
  }
  return encodePng(size, size, pixels);
}

/* -------------------------------- main -------------------------------- */

fs.mkdirSync(OUT, { recursive: true });

// macOS "Template" images are tinted by the system, so they are pure black + alpha.
write('trayInactiveTemplate.png', 18, closedEye(0.085));
write('trayInactiveTemplate@2x.png', 36, closedEye(0.085));
write('trayActiveTemplate.png', 18, openEye(0.09));
write('trayActiveTemplate@2x.png', 36, openEye(0.09));
fs.writeFileSync(path.join(OUT, 'icon.png'), appIcon(512));
console.log('wrote assets/icon.png');
