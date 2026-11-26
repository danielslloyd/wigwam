// Draws the Tellybox app icon (a little TV) and writes icons/*.png + icon.svg.
// No dependencies: shapes are rasterised with 4×4 supersampling and encoded
// as PNG with node:zlib.   Usage: node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const BG = [249, 115, 22], WHITE = [255, 255, 255], SCREEN = [43, 33, 24], PLAY = [249, 115, 22];

// Shapes in unit coordinates (0..1). Later shapes paint over earlier ones.
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r)), dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && dx * dx + dy * dy <= r * r;
};
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const segment = (ax, ay, bx, by, w) => (x, y) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  return (x - ax - t * vx) ** 2 + (y - ay - t * vy) ** 2 <= (w / 2) ** 2;
};
const triangle = (p) => (x, y) => {
  const s = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d1 = s(p[0], p[1]), d2 = s(p[1], p[2]), d3 = s(p[2], p[0]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const shapes = [
  [segment(0.5, 0.33, 0.36, 0.17, 0.035), WHITE],
  [segment(0.5, 0.33, 0.64, 0.17, 0.035), WHITE],
  [circle(0.36, 0.17, 0.035), WHITE],
  [circle(0.64, 0.17, 0.035), WHITE],
  [roundRect(0.17, 0.31, 0.83, 0.81, 0.09), WHITE],
  [roundRect(0.24, 0.38, 0.76, 0.74, 0.05), SCREEN],
  [triangle([[0.445, 0.47], [0.445, 0.65], [0.6, 0.56]]), PLAY],
];

function color(x, y) {
  let c = BG;
  for (const [hit, col] of shapes) if (hit(x, y)) c = col;
  return c;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = color((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      raw[o] = r / SS / SS; raw[o + 1] = g / SS / SS; raw[o + 2] = b / SS / SS;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [180, 192, 512]) writeFileSync(path.join(OUT, `icon-${size}.png`), png(size));

const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
writeFileSync(path.join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="${hex(BG)}"/>
  <g stroke="#fff" stroke-width="3.5" stroke-linecap="round"><line x1="50" y1="33" x2="36" y2="17"/><line x1="50" y1="33" x2="64" y2="17"/></g>
  <circle cx="36" cy="17" r="3.5" fill="#fff"/><circle cx="64" cy="17" r="3.5" fill="#fff"/>
  <rect x="17" y="31" width="66" height="50" rx="9" fill="#fff"/>
  <rect x="24" y="38" width="52" height="36" rx="5" fill="${hex(SCREEN)}"/>
  <polygon points="44.5,47 44.5,65 60,56" fill="${hex(PLAY)}"/>
</svg>
`);
console.log('Wrote icons to', OUT);
