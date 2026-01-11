// src/gooseEntity.ts
import { type AABB, type PhysicsState, defaultPhysicsTuning, stepTileAabbPhysics } from "./playerPhysics";
import type { Keys, Player, SolidTileQuery, WorldInfo } from "./playerTypes";
import { NO_KEYS } from "./playerTypes";
import { getBakedForSize, type AnimName } from "./spriteBake";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type MoveState = "groundIdle" | "groundWalk" | "airFlap";

const DEBUG = true;

const snapBakeSize = (px: number) => (px >= 30 ? 32 : px >= 22 ? 24 : px >= 14 ? 16 : 12);

// Small threshold so we don't "walk" when vx got killed by collision but input is held.
const MOVE_EPS = 0.75;

// Only consider unstick while clearly falling.
const FALL_UNSTICK_VY = 8;

// How long we must be "caught" (falling + side hit + no downward progress) before nudging.
const WALL_CATCH_T = 0.055;

// After we nudge, wait a moment before allowing another nudge (prevents oscillation).
const WALL_UNSTICK_COOLDOWN_T = 0.10;

// facing with hysteresis + cooldown (prevents rapid flip noise)
function makeFacing(initial: 1 | -1 = 1) {
  let f = initial;
  let hold = 0;
  const FLIP_V = 6;
  const HOLD_T = 0.10;

  return {
    get: () => f,
    tick(dt: number, vx: number, prefer: -1 | 0 | 1) {
      hold = Math.max(0, hold - dt);

      if (prefer) {
        f = prefer < 0 ? -1 : 1;
        hold = HOLD_T;
        return f;
      }
      if (hold > 0) return f;

      if (vx <= -FLIP_V) {
        if (f !== -1) hold = HOLD_T;
        f = -1;
      } else if (vx >= FLIP_V) {
        if (f !== 1) hold = HOLD_T;
        f = 1;
      }
      return f;
    },
  };
}

function isPushingWall(a: AABB, dir: -1 | 1, solid: SolidTileQuery, world: WorldInfo) {
  const EPS = 0.5;

  if (dir < 0) {
    if (a.x <= EPS) return true;
  } else {
    if (a.x + a.w >= world.w - EPS) return true;
  }

  const tw = world.tw | 0,
    th = world.th | 0;

  const px = dir > 0 ? a.x + a.w + 1 : a.x - 2;
  if (px < 0 || px >= world.w) return true;

  const tx = (px / tw) | 0;
  if (tx < 0 || tx >= world.tilesW) return true;

  const yMid = (a.y + a.h * 0.5) | 0;
  const tyMid = (yMid / th) | 0;

  if (tyMid < 0 || tyMid >= world.tilesH) return true;

  return solid(tx, tyMid);
}

// You're intentionally snapping bodies to integers for 1-bit stability.
const snapBody = (b: AABB) => {
  b.x = Math.round(b.x);
  b.y = Math.round(b.y);
};

function hitsAabb(x: number, y: number, w: number, h: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0,
    th = world.th | 0;

  const x0 = (x / tw) | 0;
  const y0 = (y / th) | 0;
  const x1 = ((x + w - 1) / tw) | 0;
  const y1 = ((y + h - 1) / th) | 0;

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (solid(tx, ty)) return true;
    }
  }
  return false;
}

function tryNudgeAwayFromWall(body: AABB, st: PhysicsState, solid: SolidTileQuery, world: WorldInfo) {
  // Prefer moving away from the contacted side.
  if (st.hitLeft) {
    const nx = Math.min(world.w - body.w, body.x + 1);
    if (nx !== body.x && !hitsAabb(nx, body.y, body.w, body.h, solid, world)) {
      body.x = nx;
      st.hitLeft = false;
      return true;
    }
  }

  if (st.hitRight) {
    const nx = Math.max(0, body.x - 1);
    if (nx !== body.x && !hitsAabb(nx, body.y, body.w, body.h, solid, world)) {
      body.x = nx;
      st.hitRight = false;
      return true;
    }
  }

  return false;
}

// Only unstick when we detect a *corner catch*:
// falling + side hit + not grounded + essentially no downward progress.
function handleCornerCatchUnstick(
  dt: number,
  body: AABB,
  st: PhysicsState,
  solid: SolidTileQuery,
  world: WorldInfo,
  state: { catchT: number; cooldownT: number },
  preY: number
) {
  state.cooldownT = Math.max(0, state.cooldownT - dt);

  const falling = body.vy > FALL_UNSTICK_VY;
  const sideHit = !!(st.hitLeft || st.hitRight);
  const grounded = !!st.grounded;

  // If we're actually sliding down (y increased), this is normal wall contact: do nothing.
  const dy = body.y - preY;
  const noDownProgress = dy <= 0; // snapped integers, so this works well

  if (!grounded && falling && sideHit && noDownProgress && state.cooldownT <= 0) {
    state.catchT += dt;
    if (state.catchT >= WALL_CATCH_T) {
      // Try one nudge, then cooldown.
      if (tryNudgeAwayFromWall(body, st, solid, world)) {
        state.cooldownT = WALL_UNSTICK_COOLDOWN_T;
      }
      state.catchT = 0;
    }
  } else {
    // reset unless we remain in the exact "caught" condition
    state.catchT = 0;
  }
}

export async function createGooseEntity(opts?: {
  x?: number;
  y?: number;
  scale?: number;
  controllable?: boolean;
}): Promise<Player> {
  const scale = opts?.scale ?? 1;
  const out = snapBakeSize(Math.max(12, ((32 * scale + 0.5) | 0)));
  const baked = await getBakedForSize(out, out);

  const RUN_MAX = 90,
    RUN_ACCEL = 900,
    RUN_DECEL = 1300;
  const JUMP_V = 260,
    JUMP_BUF_T = 0.10,
    GROUND_GRACE_T = 0.05;
  const BABY_SPEED_MULT = 0.85;

  const physTune = defaultPhysicsTuning();
  const physState: PhysicsState = { grounded: false, hitCeil: false, hitLeft: false, hitRight: false };

  let state: MoveState = "groundIdle";
  let anim: AnimName = "idle";
  let frame = 0,
    at = 0;

  const animLen: Record<AnimName, number> = { idle: 2, walk: 4, flap: 2 };
  const animRate: Record<AnimName, number> = { idle: 3.5, walk: 10.0, flap: 9.0 };

  let jumpBuf = 0,
    jumpLatch = false;
  let puppetJumpLatch = true;
  let groundGrace = 0;
  let puppetSpeed = 0;

  // Unstick state (separate per-entity)
  const unstick = { catchT: 0, cooldownT: 0 };

  const body: AABB = {
    x: opts?.x ?? 24,
    y: opts?.y ?? 24,
    w: out,
    h: out,
    vx: 0,
    vy: 0,
  };

  const controllable = opts?.controllable ?? true;
  const face = makeFacing(1);

  const dbg: {
    id: string;
    controllable: boolean;
    state: MoveState;
    anim: AnimName;
    frame: number;
    grounded: boolean;
    grace: number;
    hitL: boolean;
    hitR: boolean;
    hitC: boolean;
    x: number;
    y: number;
    vx: number;
    vy: number;
  } = {
    id: ((Math.random() * 1e9) | 0).toString(36),
    controllable,
    state,
    anim,
    frame,
    grounded: false,
    grace: 0,
    hitL: false,
    hitR: false,
    hitC: false,
    x: body.x,
    y: body.y,
    vx: body.vx,
    vy: body.vy,
  };

  const syncDbg = () => {
    dbg.state = state;
    dbg.anim = anim;
    dbg.frame = frame;
    dbg.grounded = !!physState.grounded;
    dbg.grace = groundGrace;
    dbg.hitL = !!physState.hitLeft;
    dbg.hitR = !!physState.hitRight;
    dbg.hitC = !!physState.hitCeil;
    dbg.x = body.x;
    dbg.y = body.y;
    dbg.vx = body.vx;
    dbg.vy = body.vy;
  };

  const log = (kind: string, extra?: string) => {
    if (!DEBUG) return;
    console.log(
      `[${dbg.id}${controllable ? ":P" : ":B"}] ${kind} ` +
        `st=${state} an=${anim}:${frame} g=${physState.grounded ? 1 : 0}(gr=${groundGrace.toFixed(2)}) ` +
        `hit(LR C)=(${physState.hitLeft ? 1 : 0}${physState.hitRight ? 1 : 0} ${physState.hitCeil ? 1 : 0}) ` +
        `v=(${body.vx.toFixed(1)},${body.vy.toFixed(1)}) ` +
        (extra ?? "")
    );
  };

  const setAnim = (next: AnimName) => {
    if (anim === next) return;
    anim = next;
    frame = 0;
    at = 0;
    log("ANIM->", next);
  };

  const tickAnim = (dt: number) => {
    at += dt * animRate[anim];
    const adv = at | 0;
    if (!adv) return;
    at -= adv;
    frame = (frame + adv) % animLen[anim];
  };

  const setState = (next: MoveState) => {
    if (state === next) return;
    state = next;
    setAnim(state === "airFlap" ? "flap" : state === "groundWalk" ? "walk" : "idle");
    log("STATE->", next);
  };

  const groundedStable = (dt: number) => {
    groundGrace = physState.grounded ? GROUND_GRACE_T : Math.max(0, groundGrace - dt);
    return physState.grounded || groundGrace > 0;
  };

  function update(dt: number, keys: Keys, solid: SolidTileQuery, world: WorldInfo) {
    const k = controllable ? keys : (NO_KEYS as Keys);

    // jump buffer
    const jp = k.up || k.a;
    if (jp && !jumpLatch) (jumpBuf = JUMP_BUF_T), (jumpLatch = true);
    if (!jp) jumpLatch = false;
    if (jumpBuf > 0) jumpBuf = Math.max(0, jumpBuf - dt);

    const ax = (k.left ? -1 : 0) + (k.right ? 1 : 0);

    // accel / decel
    if (ax) {
      body.vx = clamp(body.vx + ax * RUN_ACCEL * dt, -RUN_MAX, RUN_MAX);
    } else {
      const s = Math.sign(body.vx);
      body.vx = Math.max(0, Math.abs(body.vx) - RUN_DECEL * dt) * s;
    }

    if (jumpBuf > 0) {
      jumpBuf = 0;
      body.vy = -JUMP_V;
      log("JUMP!");
    }

    // physics then snap + (rare) corner-unstick
    const preY = body.y;
    stepTileAabbPhysics(body, physState, dt, solid, world, physTune);
    snapBody(body);
    handleCornerCatchUnstick(dt, body, physState, solid, world, unstick, preY);

    const onGround = groundedStable(dt);

    const sideHit = !!(physState.hitLeft || physState.hitRight);
    const moving = Math.abs(body.vx) > MOVE_EPS;

    if (!onGround) {
      setState("airFlap");
    } else if (!ax || sideHit || !moving) {
      setState("groundIdle");
      if (sideHit) body.vx = 0;
    } else {
      const dir = (ax < 0 ? -1 : 1) as -1 | 1;
      if (isPushingWall(body, dir, solid, world)) {
        body.vx = 0;
        setState("groundIdle");
      } else {
        setState("groundWalk");
      }
    }

    face.tick(dt, body.vx, ax as -1 | 0 | 1);
    tickAnim(dt);
    syncDbg();
  }

  function puppetStep(
    dt: number,
    masterDx: number,
    _masterDy: number,
    masterJump: boolean,
    solid: SolidTileQuery,
    world: WorldInfo
  ) {
    const dir: -1 | 0 | 1 = masterDx < 0 ? -1 : masterDx > 0 ? 1 : 0;

    if (dir !== 0 && DEBUG) log("PUPPET_INPUT", `masterDx: ${masterDx} | dir: ${dir}`);

    const pushingWall = dir !== 0 && isPushingWall(body, dir as -1 | 1, solid, world);
    const target = dir === 0 ? 0 : RUN_MAX * BABY_SPEED_MULT;

    const accel = target > puppetSpeed ? RUN_ACCEL : RUN_DECEL;
    const dv = accel * dt;
    puppetSpeed =
      puppetSpeed < target ? Math.min(target, puppetSpeed + dv) : Math.max(target, puppetSpeed - dv);

    body.vx = dir * puppetSpeed;

    if (masterJump && !puppetJumpLatch) {
      body.vy = Math.min(body.vy, -JUMP_V);
      puppetJumpLatch = true;
    }
    if (!masterJump) puppetJumpLatch = false;

    const preY = body.y;
    const preX = body.x;

    stepTileAabbPhysics(body, physState, dt, solid, world, physTune);
    snapBody(body);
    handleCornerCatchUnstick(dt, body, physState, solid, world, unstick, preY);

    if (dir !== 0 && DEBUG)
      log(
        "PHYS_RESULT",
        `vx: ${body.vx.toFixed(2)} | moved: ${(body.x - preX).toFixed(2)} | hitL: ${physState.hitLeft} | hitR: ${physState.hitRight}`
      );

    groundGrace = physState.grounded ? GROUND_GRACE_T : Math.max(0, groundGrace - dt);
    const onGround = physState.grounded || groundGrace > 0;

    if (physState.hitLeft || physState.hitRight) {
      puppetSpeed = 0;
      body.vx = 0;
    }

    const sideHit = !!(physState.hitLeft || physState.hitRight);
    const moving = Math.abs(body.vx) > MOVE_EPS;

    face.tick(dt, body.vx, dir);

    if (!onGround) setState("airFlap");
    else if (dir === 0 || pushingWall || sideHit || !moving) setState("groundIdle");
    else setState("groundWalk");

    tickAnim(dt);
    syncDbg();
  }

  function draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }) {
    ctx.imageSmoothingEnabled = false;

    const frames = anim === "walk" ? baked.walk : anim === "flap" ? baked.flap : baked.idle;
    const img = frames[frame % frames.length];

    const dx = (body.x - cam.x) | 0;
    const dy = (body.y - cam.y) | 0;

    if (face.get() === 1) {
      ctx.drawImage(img, dx, dy);
    } else {
      ctx.save();
      ctx.translate(dx + body.w, dy);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
  }

  const api: any = {
    get x() {
      return body.x;
    },
    set x(v: number) {
      body.x = v;
    },

    get y() {
      return body.y;
    },
    set y(v: number) {
      body.y = v;
    },

    w: out,
    h: out,

    get vx() {
      return body.vx;
    },
    set vx(v: number) {
      body.vx = v;
    },

    get vy() {
      return body.vy;
    },
    set vy(v: number) {
      body.vy = v;
    },

    get grounded() {
      return physState.grounded;
    },
    set grounded(v: boolean) {
      physState.grounded = v;
    },

    update,
    puppetStep,
    draw,

    _dbg: dbg,
  };

  syncDbg();
  return api as Player;
}
