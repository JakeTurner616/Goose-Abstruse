// src/main.ts
import { loadTiled, drawTile, type TiledWorld } from "./tiled";
import { createMountainBG } from "./bgMountains";

type Keys = {
  left: boolean; right: boolean; up: boolean; down: boolean;
  a: boolean; b: boolean; start: boolean; select: boolean;
};

const VIRTUAL_W = 160;
const VIRTUAL_H = 144;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d", { alpha: false })!;
ctx.imageSmoothingEnabled = false;
canvas.width = VIRTUAL_W;
canvas.height = VIRTUAL_H;

// Draw everything to offscreen, then hard-quantize to 1-bit and blit to screen.
const off = document.createElement("canvas");
off.width = VIRTUAL_W;
off.height = VIRTUAL_H;
const offCtx = off.getContext("2d", { alpha: false })!;
offCtx.imageSmoothingEnabled = false;

const keys: Keys = {
  left: false, right: false, up: false, down: false,
  a: false, b: false, start: false, select: false,
};

function setKey(e: KeyboardEvent, isDown: boolean) {
  switch (e.code) {
    case "ArrowLeft": keys.left = isDown; break;
    case "ArrowRight": keys.right = isDown; break;
    case "ArrowUp": keys.up = isDown; break;
    case "ArrowDown": keys.down = isDown; break;
    case "KeyZ": keys.a = isDown; break;
    case "KeyX": keys.b = isDown; break;
    case "Enter": keys.start = isDown; break;
    case "ShiftLeft":
    case "ShiftRight": keys.select = isDown; break;
    default: return;
  }
  if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
}
addEventListener("keydown", (e) => setKey(e, true), { passive: false });
addEventListener("keyup", (e) => setKey(e, false), { passive: false });

// Integer scale
function resize() {
  const maxW = innerWidth - 28;
  const maxH = innerHeight - 28;
  const s = Math.max(1, Math.floor(Math.min(maxW / VIRTUAL_W, maxH / VIRTUAL_H)));
  canvas.style.width = `${VIRTUAL_W * s}px`;
  canvas.style.height = `${VIRTUAL_H * s}px`;
}
addEventListener("resize", resize);
resize();

// ----------------------------------------------------------------------------
// 1-bit enforcement with world-locked ordered dithering + SKY KEY background
// ----------------------------------------------------------------------------

// 4x4 Bayer matrix (0..15)
const BAYER_4x4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

const BW_THRESHOLD = 140;
const BW_DITHER = 24;

// SKY KEY (your current sky color)
const SKY_R = 255;
const SKY_G = 204;
const SKY_B = 170;
const SKY_TOL = 2;

function isSkyKey(r: number, g: number, b: number) {
  return (
    (r - SKY_R <= SKY_TOL && SKY_R - r <= SKY_TOL) &&
    (g - SKY_G <= SKY_TOL && SKY_G - g <= SKY_TOL) &&
    (b - SKY_B <= SKY_TOL && SKY_B - b <= SKY_TOL)
  );
}

// ----------------------------------------------------------------------------
// Mountains background module
// ----------------------------------------------------------------------------
const mountainBG = createMountainBG(VIRTUAL_W, VIRTUAL_H);

// ----------------------------------------------------------------------------
// Final 1-bit blit: sky pixels sample from bg buffer, others quantize.
// ----------------------------------------------------------------------------
function blit1bit() {
  const img = offCtx.getImageData(0, 0, VIRTUAL_W, VIRTUAL_H);
  const d = img.data;

  const cx = cam.x | 0;
  const cy = cam.y | 0;

  for (let y = 0; y < VIRTUAL_H; y++) {
    const wy = (y + cy) & 3;

    for (let x = 0; x < VIRTUAL_W; x++) {
      const i = ((y * VIRTUAL_W + x) << 2);
      const r = d[i], g = d[i + 1], b = d[i + 2];

      // Replace sky-key pixels with the procedural mountain background
      if (isSkyKey(r, g, b)) {
        const vbg = mountainBG.sampleScreen(x, y); // 0 or 255
        d[i] = vbg; d[i + 1] = vbg; d[i + 2] = vbg; d[i + 3] = 255;
        continue;
      }

      const l = (77 * r + 150 * g + 29 * b) >> 8;

      const wx = (x + cx) & 3;
      const m = BAYER_4x4[wx | (wy << 2)];
      const t = BW_THRESHOLD + ((m - 7.5) * (BW_DITHER / 8));

      const v = l >= t ? 255 : 0;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ----------------------------------------------------------------------------
// World + camera
// ----------------------------------------------------------------------------
const player = { x: 24, y: 24, w: 8, h: 8, speed: 70 };
const cam = { x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

let world: TiledWorld | null = null;

function updateCamera() {
  if (!world) return;
  const { map } = world;

  const ww = map.w * map.tw;
  const wh = map.h * map.th;

  cam.x = ((player.x + (player.w >> 1)) - (VIRTUAL_W >> 1)) | 0;
  cam.y = ((player.y + (player.h >> 1)) - (VIRTUAL_H >> 1)) | 0;

  cam.x = clamp(cam.x, 0, Math.max(0, ww - VIRTUAL_W));
  cam.y = clamp(cam.y, 0, Math.max(0, wh - VIRTUAL_H));
}

// ----------------------------------------------------------------------------
// Game loop
// ----------------------------------------------------------------------------
function update(dt: number) {
  let dx = 0, dy = 0;
  if (keys.left) dx--;
  if (keys.right) dx++;
  if (keys.up) dy--;
  if (keys.down) dy++;

  if (dx && dy) {
    const inv = 1 / Math.sqrt(2);
    dx *= inv; dy *= inv;
  }

  player.x += dx * player.speed * dt;
  player.y += dy * player.speed * dt;

  if (world) {
    const { map } = world;
    const ww = map.w * map.tw;
    const wh = map.h * map.th;
    player.x = clamp(player.x, 0, ww - player.w);
    player.y = clamp(player.y, 0, wh - player.h);
  } else {
    player.x = clamp(player.x, 0, VIRTUAL_W - player.w);
    player.y = clamp(player.y, 0, VIRTUAL_H - player.h);
  }

  updateCamera();
}

function draw() {
  offCtx.fillStyle = "#000";
  offCtx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H);

  if (world) drawMap();
  drawPlayer();
  drawHud();
}

function drawMap() {
  if (!world) return;
  const { map, ts } = world;

  const tw = map.tw, th = map.th;

  const x0 = clamp((cam.x / tw) | 0, 0, map.w);
  const y0 = clamp((cam.y / th) | 0, 0, map.h);
  const x1 = clamp(((cam.x + VIRTUAL_W + tw - 1) / tw) | 0, 0, map.w);
  const y1 = clamp(((cam.y + VIRTUAL_H + th - 1) / th) | 0, 0, map.h);

  const ox = cam.x - x0 * tw;
  const oy = cam.y - y0 * th;

  for (let ty = y0; ty < y1; ty++) {
    const row = ty * map.w;
    const dy = ((ty - y0) * th - oy) | 0;

    for (let tx = x0; tx < x1; tx++) {
      const gid = map.layer[row + tx] >>> 0;
      if ((gid & 0x1fffffff) === 0) continue;
      const dx = ((tx - x0) * tw - ox) | 0;
      drawTile(offCtx, ts, gid, dx, dy);
    }
  }
}

function drawPlayer() {
  offCtx.fillStyle = keys.a ? "#fff" : "#000";
  offCtx.fillRect(
    (player.x - cam.x) | 0,
    (player.y - cam.y) | 0,
    player.w,
    player.h
  );
}

function drawHud() {
  offCtx.fillStyle = "#fff";
  offCtx.font = "10px monospace";
  offCtx.fillText(world ? "MAP OK" : "LOADING...", 4, 12);
}

let last = performance.now();

function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  update(dt);

  // Update the background with current camera position
  mountainBG.render(cam.x | 0, cam.y | 0);

  draw();
  blit1bit();

  requestAnimationFrame(frame);
}

// Boot
(async () => {
  try {
    world = await loadTiled("/Tiled/sample-map.tmx");
    updateCamera();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(frame);
})();
