// tools/png-to-bits.js
// Convert a 1-bit-ish PNG icon into `0b........` rows for Uint8Array.
//
// Install:
//   npm i -D pngjs
//
// Usage:
//   node tools/png-to-bits.js path/to/icon.png
//   node tools/png-to-bits.js path/to/icon.png ICON_NAME
//
// Notes:
// - Treats pixels as "ON" if alpha >= 128 AND luminance < 128 (dark pixel)
// - Outputs rows MSB->LSB (leftmost pixel is the highest bit), matching your drawIcon8 logic:
//     if (row & (0x80 >> rx)) ...
// - Supports width up to 32 (outputs 1..4 bytes per row).
//   For 8px wide icons you'll get exactly one `0b........` per row.

import fs from "node:fs";
import { PNG } from "pngjs";

const file = process.argv[2];
const nameArg = process.argv[3];

if (!file) {
  console.error("Usage: node tools/png-to-bits.js icon.png [ICON_NAME]");
  process.exit(1);
}

const png = PNG.sync.read(fs.readFileSync(file));
const w = png.width | 0;
const h = png.height | 0;
const data = png.data;

if (w <= 0 || h <= 0) throw new Error("Invalid PNG size.");
if (w > 32) throw new Error(`Width ${w} too large. Max supported width is 32.`);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function luminance(r, g, b) {
  // perceptual-ish luma, integer
  return (r * 299 + g * 587 + b * 114) / 1000;
}

const ALPHA_CUT = 128;
const LUMA_CUT = 128;

// Determine if pixel should be considered "ON" (set bit)
function isOn(x, y) {
  const i = ((y * w + x) << 2) | 0;
  const r = data[i] | 0;
  const g = data[i + 1] | 0;
  const b = data[i + 2] | 0;
  const a = data[i + 3] | 0;

  if (a < ALPHA_CUT) return false;

  // If it's dark => ON, if bright => OFF
  return luminance(r, g, b) < LUMA_CUT;
}

// Pack row into N bytes (ceil(w/8)).
// Leftmost pixel is highest bit of the first byte.
const bytesPerRow = ((w + 7) >> 3) | 0;

function byteToBin8(n) {
  n &= 255;
  let s = n.toString(2);
  while (s.length < 8) s = "0" + s;
  return `0b${s}`;
}

function byteToHex2(n) {
  n &= 255;
  let s = n.toString(16).toUpperCase();
  if (s.length < 2) s = "0" + s;
  return `0x${s}`;
}

// Build packed rows
const rows = [];
for (let y = 0; y < h; y++) {
  const rowBytes = new Array(bytesPerRow).fill(0);

  for (let x = 0; x < w; x++) {
    if (!isOn(x, y)) continue;

    const bi = (x >> 3) | 0;          // byte index in this row
    const bit = 7 - (x & 7);          // MSB-first within that byte
    rowBytes[bi] |= 1 << bit;
  }

  rows.push(rowBytes);
}

// Pretty print:
// - If width <= 8, prints just `0b........` per row.
// - Else prints multiple bytes per row.
const iconName = nameArg || `ICON_${w}x${h}`;
const type = w <= 8 ? "Uint8Array" : "Uint8Array"; // still fine; multiple bytes per row

console.log(`// ${file}`);
console.log(`// Size: ${w}x${h}`);
console.log(`// bytesPerRow=${bytesPerRow} (MSB-first)`);

if (bytesPerRow === 1) {
  console.log(`\nexport const ${iconName}: ${type} = new Uint8Array([`);
  for (let y = 0; y < h; y++) {
    const b = rows[y][0] | 0;
    const bin = byteToBin8(b);
    console.log(`  ${bin},`);
  }
  console.log(`]);`);
} else {
  // Flatten as rows laid out consecutively
  // Access pattern would be: byte = data[y*bytesPerRow + bi]
  console.log(`\nexport const ${iconName}: ${type} = new Uint8Array([`);
  for (let y = 0; y < h; y++) {
    const rowBytes = rows[y];
    const parts = rowBytes.map((b) => byteToHex2(b)).join(", ");
    console.log(`  // y=${y}`);
    console.log(`  ${parts},`);
  }
  console.log(`]);`);
  console.log(`\n// For w>8, you can draw with:`);
  console.log(`// for y in 0..h-1, for x in 0..w-1:`);
  console.log(`//   bi=(x>>3), bit=7-(x&7), byte=data[y*bytesPerRow+bi], on=byte&(1<<bit)`);
}
