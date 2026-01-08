// src/player.ts
type Keys = {
  left: boolean; right: boolean; up: boolean; down: boolean;
  a: boolean; b: boolean; start: boolean; select: boolean;
};

export type SolidTileQuery = (tx: number, ty: number) => boolean;

export type WorldInfo = {
  w: number; h: number;       // world pixels
  tw: number; th: number;     // tile pixels
  tilesW: number; tilesH: number;
};

export type Player = {
  x: number;
  y: number;
  w: number;
  h: number;

  vx: number;
  vy: number;

  grounded: boolean;

  update(dt: number, keys: Keys, isSolidTile: SolidTileQuery, world: WorldInfo): void;
  draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }): void;
};

import {
  type AABB,
  type PhysicsState,
  defaultPhysicsTuning,
  stepTileAabbPhysics,
} from "./playerPhysics";

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

type AnimName = "idle" | "walk" | "flap";
type BakedFrame = HTMLCanvasElement;

type BBox = { x0: number; y0: number; x1: number; y1: number };
const EMPTY_BOX: BBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

function unionBox(a: BBox, b: BBox): BBox {
  if (a.x1 <= a.x0) return { ...b };
  if (b.x1 <= b.x0) return { ...a };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function expandBox(b: BBox, pad: number, w: number, h: number): BBox {
  if (b.x1 <= b.x0) return { x0: 0, y0: 0, x1: w, y1: h };
  return {
    x0: Math.max(0, b.x0 - pad),
    y0: Math.max(0, b.y0 - pad),
    x1: Math.min(w, b.x1 + pad),
    y1: Math.min(h, b.y1 + pad),
  };
}

function computeFrameBBox(
  img: HTMLImageElement,
  frameIndex: number,
  srcFrameW: number,
  srcFrameH: number,
  alphaCutoff = 1
): BBox {
  const tmp = document.createElement("canvas");
  tmp.width = srcFrameW;
  tmp.height = srcFrameH;

  const tctx = tmp.getContext("2d", { alpha: true })!;
  tctx.imageSmoothingEnabled = false;
  tctx.clearRect(0, 0, srcFrameW, srcFrameH);
  tctx.drawImage(img, frameIndex * srcFrameW, 0, srcFrameW, srcFrameH, 0, 0, srcFrameW, srcFrameH);

  const id = tctx.getImageData(0, 0, srcFrameW, srcFrameH);
  const d = id.data;

  let x0 = srcFrameW, y0 = srcFrameH, x1 = 0, y1 = 0;
  let any = false;

  for (let y = 0; y < srcFrameH; y++) {
    let row = (y * srcFrameW) << 2;
    for (let x = 0; x < srcFrameW; x++) {
      if (d[row + 3] >= alphaCutoff) {
        any = true;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
      row += 4;
    }
  }

  return any ? { x0, y0, x1, y1 } : { ...EMPTY_BOX };
}

function bakeStripFramesAutoCrop(opts: {
  img: HTMLImageElement;
  frameCount: number;
  srcFrameW: number;
  srcFrameH: number;
  crop: BBox;
  outW: number;
  outH: number;
  bwThreshold?: number;
}): BakedFrame[] {
  const { img, frameCount, srcFrameW, srcFrameH, crop, outW, outH, bwThreshold = 128 } = opts;

  const cw = Math.max(1, crop.x1 - crop.x0);
  const ch = Math.max(1, crop.y1 - crop.y0);

  const frames: BakedFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;

    const cctx = c.getContext("2d", { alpha: true })!;
    cctx.imageSmoothingEnabled = false;

    const sx = i * srcFrameW + crop.x0;
    const sy = crop.y0;

    cctx.clearRect(0, 0, outW, outH);
    cctx.drawImage(img, sx, sy, cw, ch, 0, 0, outW, outH);

    const id = cctx.getImageData(0, 0, outW, outH);
    const d = id.data;

    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3];
      if (a === 0) continue;

      const r = d[p], g = d[p + 1], b = d[p + 2];
      const l = (77 * r + 150 * g + 29 * b) >> 8;
      const v = l >= bwThreshold ? 255 : 0;

      d[p] = v;
      d[p + 1] = v;
      d[p + 2] = v;
      d[p + 3] = 255;
    }

    cctx.putImageData(id, 0, 0);
    frames.push(c);
  }

  return frames;
}

export async function createPlayer(opts?: { x?: number; y?: number }): Promise<Player> {
  const idleImg = await loadImage("/Sprites/Idle.png");
  const walkImg = await loadImage("/Sprites/Walk.png");
  const flapImg = await loadImage("/Sprites/Flap.png");

  const SRC_FRAME_W = 64;
  const SRC_FRAME_H = 64;

  const OUT_W = 32;
  const OUT_H = 32;

  const IDLE_N = 2;
  const WALK_N = 4;
  const FLAP_N = 2;

  const PAD = 2;
  let cropAll: BBox = { ...EMPTY_BOX };
  for (let i = 0; i < IDLE_N; i++) cropAll = unionBox(cropAll, computeFrameBBox(idleImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));
  for (let i = 0; i < WALK_N; i++) cropAll = unionBox(cropAll, computeFrameBBox(walkImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));
  for (let i = 0; i < FLAP_N; i++) cropAll = unionBox(cropAll, computeFrameBBox(flapImg, i, SRC_FRAME_W, SRC_FRAME_H, 1));
  cropAll = expandBox(cropAll, PAD, SRC_FRAME_W, SRC_FRAME_H);

  const idleFrames = bakeStripFramesAutoCrop({
    img: idleImg,
    frameCount: IDLE_N,
    srcFrameW: SRC_FRAME_W,
    srcFrameH: SRC_FRAME_H,
    crop: cropAll,
    outW: OUT_W,
    outH: OUT_H,
    bwThreshold: 128,
  });

  const walkFrames = bakeStripFramesAutoCrop({
    img: walkImg,
    frameCount: WALK_N,
    srcFrameW: SRC_FRAME_W,
    srcFrameH: SRC_FRAME_H,
    crop: cropAll,
    outW: OUT_W,
    outH: OUT_H,
    bwThreshold: 128,
  });

  const flapFrames = bakeStripFramesAutoCrop({
    img: flapImg,
    frameCount: FLAP_N,
    srcFrameW: SRC_FRAME_W,
    srcFrameH: SRC_FRAME_H,
    crop: cropAll,
    outW: OUT_W,
    outH: OUT_H,
    bwThreshold: 128,
  });

  // --------------------------------------------------------------------------
  // Movement tuning
  // --------------------------------------------------------------------------
  const RUN_MAX = 90;
  const RUN_ACCEL = 900;
  const RUN_DECEL = 1300;

  const JUMP_V = 260;
  const COYOTE_T = 0.08;
  const JUMP_BUF_T = 0.10;

  // --------------------------------------------------------------------------
  // Physics
  // --------------------------------------------------------------------------
  const physTune = defaultPhysicsTuning();
  const physState: PhysicsState = {
    grounded: false,
    hitCeil: false,
    hitLeft: false,
    hitRight: false,
  };

  // --------------------------------------------------------------------------
  // Movement/anim state machine
  // --------------------------------------------------------------------------
  type MoveState = "groundIdle" | "groundWalk" | "airFlap";
  let state: MoveState = "groundIdle";

  let facing = 1;

  let anim: AnimName = "idle";
  let frame = 0;
  let at = 0;

  const animLen: Record<AnimName, number> = { idle: IDLE_N, walk: WALK_N, flap: FLAP_N };
  const animRate: Record<AnimName, number> = { idle: 3.5, walk: 10.0, flap: 9.0 };

  let coyote = 0;
  let jumpBuf = 0;
  let jumpLatch = false;

  const body: AABB = {
    x: opts?.x ?? 24,
    y: opts?.y ?? 24,
    w: OUT_W,
    h: OUT_H,
    vx: 0,
    vy: 0,
  };

  function setAnim(next: AnimName) {
    if (anim === next) return;
    anim = next;
    frame = 0;
    at = 0;
  }

  function tickAnim(dt: number) {
    at += dt * animRate[anim];
    const adv = at | 0;
    if (adv) {
      at -= adv;
      frame = (frame + adv) % animLen[anim];
    }
  }

  function updateMoveState() {
    if (!physState.grounded) state = "airFlap";
    else state = Math.abs(body.vx) > 5 ? "groundWalk" : "groundIdle";
  }

  function applyStateToAnim() {
    if (state === "airFlap") setAnim("flap");
    else if (state === "groundWalk") setAnim("walk");
    else setAnim("idle");
  }

  function update(dt: number, keys: Keys, isSolidTile: SolidTileQuery, world: WorldInfo) {
    // Jump buffer + latch
    const jumpPressed = keys.up || keys.a;
    if (jumpPressed && !jumpLatch) {
      jumpBuf = JUMP_BUF_T;
      jumpLatch = true;
    }
    if (!jumpPressed) jumpLatch = false;
    if (jumpBuf > 0) jumpBuf = Math.max(0, jumpBuf - dt);

    // Coyote off true grounded
    if (physState.grounded) coyote = COYOTE_T;
    else coyote = Math.max(0, coyote - dt);

    // Horizontal input
    const ax = (keys.left ? -1 : 0) + (keys.right ? 1 : 0);
    if (ax) {
      body.vx += ax * RUN_ACCEL * dt;
      body.vx = clamp(body.vx, -RUN_MAX, RUN_MAX);
      facing = ax < 0 ? -1 : 1;
    } else {
      const s = Math.sign(body.vx);
      const v = Math.abs(body.vx);
      const nv = Math.max(0, v - RUN_DECEL * dt);
      body.vx = nv * s;
    }

    // Jump consume
    if (jumpBuf > 0 && coyote > 0) {
      jumpBuf = 0;
      coyote = 0;
      body.vy = -JUMP_V;
    }

    // Physics step (tile AABB)
    stepTileAabbPhysics(body, physState, dt, isSolidTile, world, physTune);

    // State + anim
    updateMoveState();
    applyStateToAnim();
    tickAnim(dt);
  }

  function draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }) {
    ctx.imageSmoothingEnabled = false;

    const frames = anim === "walk" ? walkFrames : anim === "flap" ? flapFrames : idleFrames;
    const img = frames[frame % frames.length];

    const dx = (body.x - cam.x) | 0;
    const dy = (body.y - cam.y) | 0;

    if (facing === 1) {
      ctx.drawImage(img, dx, dy);
    } else {
      ctx.save();
      ctx.translate(dx + body.w, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }

  return {
    get x() { return body.x; },
    set x(v: number) { body.x = v; },

    get y() { return body.y; },
    set y(v: number) { body.y = v; },

    w: OUT_W,
    h: OUT_H,

    get vx() { return body.vx; },
    set vx(v: number) { body.vx = v; },

    get vy() { return body.vy; },
    set vy(v: number) { body.vy = v; },

    get grounded() { return physState.grounded; },
    set grounded(v: boolean) { physState.grounded = v; },

    update,
    draw,
  };
}
