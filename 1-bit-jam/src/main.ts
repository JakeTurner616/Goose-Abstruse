// src/main.ts
import { loadTiled, drawTile, type TiledWorld, GID_MASK } from "./tiled";
import { createMountainBG } from "./bgMountains";
import { createPlayer, type Player } from "./player";

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

// -----------------------------------------------------------------------------
// Z key (A button) toggles inverse palette for the 1-bit renderer.
// We latch on "keydown edge" so holding Z doesn't flip every frame.
// -----------------------------------------------------------------------------
let invert = false;
let invertLatch = false;

function setKey(e: KeyboardEvent, isDown: boolean) {
  switch (e.code) {
    case "ArrowLeft": keys.left = isDown; break;
    case "ArrowRight": keys.right = isDown; break;
    case "ArrowUp": keys.up = isDown; break;
    case "ArrowDown": keys.down = isDown; break;

    case "KeyZ":
      keys.a = isDown;
      if (isDown && !invertLatch) {
        invert = !invert;
        invertLatch = true;
      }
      if (!isDown) invertLatch = false;
      break;

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
// World + camera
// ----------------------------------------------------------------------------
let player: Player; // created in boot
const cam = { x: 0, y: 0 };

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

let world: TiledWorld | null = null;

function updateCamera() {
  if (!player) return;

  const ww = world ? (world.map.w * world.map.tw) : VIRTUAL_W;
  const wh = world ? (world.map.h * world.map.th) : VIRTUAL_H;

  cam.x = ((player.x + (player.w >> 1)) - (VIRTUAL_W >> 1)) | 0;
  cam.y = ((player.y + (player.h >> 1)) - (VIRTUAL_H >> 1)) | 0;

  cam.x = clamp(cam.x, 0, Math.max(0, ww - VIRTUAL_W));
  cam.y = clamp(cam.y, 0, Math.max(0, wh - VIRTUAL_H));
}

// ----------------------------------------------------------------------------
// Tile collision helper (BOX SOLID): collide layer gid != 0 => whole tile solid
// ----------------------------------------------------------------------------
function isSolidTile(tx: number, ty: number) {
  if (!world) return false;

  const { map } = world;

  // Treat outside-of-map as solid so you can't escape.
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;

  const gidRaw = map.collide[ty * map.w + tx] >>> 0;
  return (gidRaw & GID_MASK) !== 0;
}

// ----------------------------------------------------------------------------
// Final 1-bit blit: sky pixels sample from bg buffer, others quantize.
// Add invert toggle that flips final 0/255 output.
// ----------------------------------------------------------------------------
function blit1bit() {
  const img = offCtx.getImageData(0, 0, VIRTUAL_W, VIRTUAL_H);
  const d = img.data;

  const cx = cam.x | 0;
  const cy = cam.y | 0;

  // palette endpoints (0/255) possibly inverted
  const BLACK = invert ? 255 : 0;
  const WHITE = invert ? 0 : 255;

  for (let y = 0; y < VIRTUAL_H; y++) {
    const wy = (y + cy) & 3;

    for (let x = 0; x < VIRTUAL_W; x++) {
      const i = ((y * VIRTUAL_W + x) << 2);
      const r = d[i], g = d[i + 1], b = d[i + 2];

      // Replace sky-key pixels with the procedural mountain background
      if (isSkyKey(r, g, b)) {
        const vbg = mountainBG.sampleScreen(x, y) ? WHITE : BLACK; // 0/255
        d[i] = vbg; d[i + 1] = vbg; d[i + 2] = vbg; d[i + 3] = 255;
        continue;
      }

      const l = (77 * r + 150 * g + 29 * b) >> 8;

      const wx4 = (x + cx) & 3;
      const m = BAYER_4x4[wx4 | (wy << 2)];
      const t = BW_THRESHOLD + ((m - 7.5) * (BW_DITHER / 8));

      const v = l >= t ? WHITE : BLACK;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ----------------------------------------------------------------------------
// Game loop
// ----------------------------------------------------------------------------
function update(dt: number) {
  if (!player) return;

  if (world) {
    const ww = world.map.w * world.map.tw;
    const wh = world.map.h * world.map.th;

    player.update(dt, keys, isSolidTile, {
      w: ww,
      h: wh,
      tw: world.map.tw,
      th: world.map.th,
      tilesW: world.map.w,
      tilesH: world.map.h,
    });
  } else {
    player.update(dt, keys, () => false, {
      w: VIRTUAL_W,
      h: VIRTUAL_H,
      tw: 8,
      th: 8,
      tilesW: (VIRTUAL_W / 8) | 0,
      tilesH: (VIRTUAL_H / 8) | 0,
    });
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

  const tileLayer = map.tile;
  const collideLayer = map.collide;

  for (let ty = y0; ty < y1; ty++) {
    const row = ty * map.w;
    const dy = ((ty - y0) * th - oy) | 0;

    for (let tx = x0; tx < x1; tx++) {
      const dx = ((tx - x0) * tw - ox) | 0;

      // Visual layer
      const gidA = tileLayer[row + tx] >>> 0;
      if ((gidA & GID_MASK) !== 0) drawTile(offCtx, ts, gidA, dx, dy);

      // Collide layer (also rendered)
      const gidB = collideLayer[row + tx] >>> 0;
      if ((gidB & GID_MASK) !== 0) drawTile(offCtx, ts, gidB, dx, dy);
    }
  }
}

function drawPlayer() {
  if (!player) return;
  player.draw(offCtx, cam);
}

function drawHud() {
  offCtx.fillStyle = invert ? "#000" : "#fff"; // readable against current palette
  offCtx.font = "10px monospace";
  const g = player?.grounded ? "G" : " ";
  const inv = invert ? "INV" : "   ";
  offCtx.fillText(world ? `MAP OK ${g} ${inv}` : "LOADING...", 4, 12);
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
    player = await createPlayer({ x: 24, y: 24 });

    world = await loadTiled("/Tiled/sample-map.tmx");

    // Start above the map so you can fall onto collide tiles.
    player.x = 24;
    player.y = 0;

    updateCamera();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(frame);
})();
