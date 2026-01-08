// src/gooseEntity.ts
import {
  type AABB,
  type PhysicsState,
  defaultPhysicsTuning,
  stepTileAabbPhysics,
} from "./playerPhysics";

import type { Keys, Player, SolidTileQuery, WorldInfo } from "./playerTypes";
import { NO_KEYS } from "./playerTypes";
import { getBakedForSize, type AnimName } from "./spriteBake";

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

type MoveState = "groundIdle" | "groundWalk" | "airFlap";

// Snap baked sprite sizes to “clean” pixel-art sizes.
function snapBakeSize(px: number) {
  if (px >= 30) return 32;
  if (px >= 22) return 24;
  if (px >= 14) return 16;
  return 12;
}

// “Sticky” integer snapper: prevents 0.49↔0.51 boundary flips from jitter pushes.
function makeStickySnap(deadband = 0.20) {
  let init = false;
  let ix = 0;
  let iy = 0;

  function snap1(v: number, last: number) {
    // prefer floor (so it matches your current pipeline)
    const f = v | 0;

    if (!init) return f;

    // keep last unless we clearly moved far enough past the boundary
    // - if we're within [last - deadband, last + 1 + deadband], stick to last
    // - otherwise update to the new floor
    if (v >= last - deadband && v <= last + 1 + deadband) return last;
    return f;
  }

  return {
    snap(x: number, y: number) {
      if (!init) {
        ix = x | 0;
        iy = y | 0;
        init = true;
        return { x: ix, y: iy };
      }

      const nx = snap1(x, ix);
      const ny = snap1(y, iy);
      ix = nx;
      iy = ny;
      return { x: ix, y: iy };
    },
    reset() {
      init = false;
    },
  };
}

export async function createGooseEntity(opts?: {
  x?: number;
  y?: number;
  scale?: number;          // 1 = goose, <1 = gooseling
  controllable?: boolean;  // false = ignores input (but still simulates)
}): Promise<Player> {
  const scale = opts?.scale ?? 1;

  const target = Math.max(12, (32 * scale + 0.5) | 0);
  const OUT_W = snapBakeSize(target);
  const OUT_H = OUT_W;

  const baked = await getBakedForSize(OUT_W, OUT_H);
  const idleFrames = baked.idle;
  const walkFrames = baked.walk;
  const flapFrames = baked.flap;

  // Movement tuning (goose/controller only)
  const RUN_MAX = 90;
  const RUN_ACCEL = 900;
  const RUN_DECEL = 1300;

  const JUMP_V = 260;
  const COYOTE_T = 0.08;
  const JUMP_BUF_T = 0.10;

  // --- State smoothing
  const GROUND_GRACE_T = 0.05;

  // Hysteresis so walk/idle doesn’t thrash near the threshold.
  const WALK_ENTER = 8; // px/s
  const WALK_EXIT = 4;  // px/s

  // Physics
  const physTune = defaultPhysicsTuning();
  const physState: PhysicsState = {
    grounded: false,
    hitCeil: false,
    hitLeft: false,
    hitRight: false,
  };

  // State
  let state: MoveState = "groundIdle";
  let facing = 1;

  let anim: AnimName = "idle";
  let frame = 0;
  let at = 0;

  const animLen: Record<AnimName, number> = { idle: 2, walk: 4, flap: 2 };
  const animRate: Record<AnimName, number> = { idle: 3.5, walk: 10.0, flap: 9.0 };

  // goose-only jump state
  let coyote = 0;
  let jumpBuf = 0;
  let jumpLatch = false;

  // puppet jump latch:
  let puppetJumpLatch = true;

  // grounded smoothing
  let groundGrace = 0;

  const body: AABB = {
    x: opts?.x ?? 24,
    y: opts?.y ?? 24,
    w: OUT_W,
    h: OUT_H,
    vx: 0,
    vy: 0,
  };

  const controllable = opts?.controllable ?? true;

  // Only puppets get sticky pixel snap (this is the targeted fix).
  // Deadband tuned small to remove shimmer without making motion feel “laggy”.
  const sticky = makeStickySnap(0.22);

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

  function setState(next: MoveState) {
    if (state === next) return;
    state = next;

    if (state === "airFlap") setAnim("flap");
    else if (state === "groundWalk") setAnim("walk");
    else setAnim("idle");
  }

  function postPhysicsStateUpdate(dt: number, vxForState: number) {
    if (physState.grounded) groundGrace = GROUND_GRACE_T;
    else groundGrace = Math.max(0, groundGrace - dt);

    const groundedStable = physState.grounded || groundGrace > 0;

    if (!groundedStable) {
      setState("airFlap");
      return;
    }

    const av = Math.abs(vxForState);

    if (state === "groundWalk") {
      if (av <= WALK_EXIT) setState("groundIdle");
      else setState("groundWalk");
    } else {
      if (av >= WALK_ENTER) setState("groundWalk");
      else setState("groundIdle");
    }
  }

  // Normal controller (goose)
  function update(dt: number, keys: Keys, isSolidTile: SolidTileQuery, world: WorldInfo) {
    const k = controllable ? keys : (NO_KEYS as Keys);

    const jumpPressed = k.up || k.a;
    if (jumpPressed && !jumpLatch) {
      jumpBuf = JUMP_BUF_T;
      jumpLatch = true;
    }
    if (!jumpPressed) jumpLatch = false;
    if (jumpBuf > 0) jumpBuf = Math.max(0, jumpBuf - dt);

    if (physState.grounded) coyote = COYOTE_T;
    else coyote = Math.max(0, coyote - dt);

    const ax = (k.left ? -1 : 0) + (k.right ? 1 : 0);
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

    if (jumpBuf > 0 && coyote > 0) {
      jumpBuf = 0;
      coyote = 0;
      body.vy = -JUMP_V;
    }

    stepTileAabbPhysics(body, physState, dt, isSolidTile, world, physTune);

    if (body.vx < -1) facing = -1;
    else if (body.vx > 1) facing = 1;

    postPhysicsStateUpdate(dt, body.vx);
    tickAnim(dt);

    // goose: no sticky snap needed; but if you ever toggle controllable at runtime,
    // keep snapper coherent.
    sticky.reset();
  }

  function puppetStep(
    dt: number,
    masterDx: number,
    _masterDy: number,
    masterJump: boolean,
    isSolidTile: SolidTileQuery,
    world: WorldInfo
  ) {
    const x0 = body.x;
    const y0 = body.y;

    const targetVx = dt > 0 ? (masterDx / dt) : 0;

    const FOLLOW_RATE = 18;
    const t = Math.min(1, dt * FOLLOW_RATE);
    body.vx = body.vx + (targetVx - body.vx) * t;

    if (masterJump && !puppetJumpLatch) {
      body.vy = Math.min(body.vy, -JUMP_V);
      puppetJumpLatch = true;
    }
    if (!masterJump) puppetJumpLatch = false;

    stepTileAabbPhysics(body, physState, dt, isSolidTile, world, physTune);

    if (physState.hitLeft || physState.hitRight) body.vx = 0;

    const adx = body.x - x0;
    const ady = body.y - y0;

    if (adx < -0.01) facing = -1;
    else if (adx > 0.01) facing = 1;

    const vxActual = dt > 0 ? (adx / dt) : 0;

    postPhysicsStateUpdate(dt, vxActual);
    tickAnim(dt);

    void ady;
  }

  function draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }) {
    ctx.imageSmoothingEnabled = false;

    const frames = anim === "walk" ? walkFrames : anim === "flap" ? flapFrames : idleFrames;
    const img = frames[frame % frames.length];

    const rx = body.x - cam.x;
    const ry = body.y - cam.y;

    // Goose stays exactly as before.
    // Gooselings use sticky snap to avoid boundary flicker from tiny collision nudges.
    const snapped = controllable ? { x: rx | 0, y: ry | 0 } : sticky.snap(rx, ry);

    const dx = snapped.x;
    const dy = snapped.y;

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
    puppetStep,
    draw,
  };
}
