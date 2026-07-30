// scripts/make-icons.mjs — regenerate the PWA icons.  Run with: node scripts/make-icons.mjs
//
// Writes real PNGs with no dependencies: node's built-in zlib supplies the only hard part
// (deflate), and the rest of the PNG container is a signature plus three CRC-checked chunks.
// Keeping this as a script rather than committing opaque binaries means the icon can be re-tinted
// by editing two hex values instead of opening an image editor.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, "..", "icons");
const EXT_ICONS = join(HERE, "..", "extension", "icons");

const CLAY = [0xb3, 0x50, 0x2e];   // --clay
const PAPER = [0xfb, 0xf7, 0xf0];  // --paper

// --- PNG encoding -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // Each scanline is prefixed with a filter-type byte; 0 means "none".
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- the artwork ------------------------------------------------------------
// A plate: terracotta field, cream disc, and a thin terracotta rim inside it. Drawn with per-pixel
// distance tests and 4x supersampling, which is enough to keep the curves clean at every size.
//
// `inset` shrinks the artwork for maskable icons, where launchers crop up to 20% off every edge —
// a full-bleed plate would lose its rim to the crop.
function drawIcon(size, { inset = 0 } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const usable = (size / 2) * (1 - inset);
  const rPlate = usable * 0.66;
  const rRimOuter = usable * 0.50;
  const rRimInner = usable * 0.455;
  const SS = 4;   // supersample factor per axis

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plate = 0, rim = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS - 0.5;
          const py = y + (sy + 0.5) / SS - 0.5;
          const d = Math.hypot(px - c, py - c);
          if (d <= rPlate) plate++;
          if (d <= rRimOuter && d >= rRimInner) rim++;
        }
      }
      const n = SS * SS;
      const plateA = plate / n;
      const rimA = rim / n;

      // Composite: clay field -> cream plate -> clay rim.
      let r = CLAY[0], g = CLAY[1], b = CLAY[2];
      r = r + (PAPER[0] - r) * plateA;
      g = g + (PAPER[1] - g) * plateA;
      b = b + (PAPER[2] - b) * plateA;
      r = r + (CLAY[0] - r) * rimA;
      g = g + (CLAY[1] - g) * rimA;
      b = b + (CLAY[2] - b) * rimA;

      const i = (y * size + x) * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = 255;
    }
  }
  return buf;
}

mkdirSync(ICONS, { recursive: true });
mkdirSync(EXT_ICONS, { recursive: true });

const targets = [
  [ICONS, "icon-192.png", 192, {}],
  [ICONS, "icon-512.png", 512, {}],
  // Maskable icons get cropped by the launcher, so the artwork is inset to survive it.
  [ICONS, "icon-maskable-512.png", 512, { inset: 0.2 }],
  [ICONS, "apple-touch-icon.png", 180, {}],
  // Chrome extension toolbar/store sizes — same plate mark, just smaller renders.
  [EXT_ICONS, "icon-16.png", 16, {}],
  [EXT_ICONS, "icon-32.png", 32, {}],
  [EXT_ICONS, "icon-48.png", 48, {}],
  [EXT_ICONS, "icon-128.png", 128, {}],
];

for (const [dir, name, size, opts] of targets) {
  writeFileSync(join(dir, name), encodePng(size, drawIcon(size, opts)));
  console.log(`wrote ${dir === EXT_ICONS ? "extension/icons" : "icons"}/${name} (${size}×${size})`);
}
