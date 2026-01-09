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

function snapBakeSize(px: number) {
  if (px >= 30) return 32;
  if (px >= 22) return 24;
  if (px >= 14) return 16;
  return 12;
}

function makeStickySnap(deadband = 0.20) {
  let init = false;
  let ix = 0;
  let iy = 0;

  function snap1(v: number, last: number) {
    const f = v | 0;
    if (!init) return f;
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

// facing with hysteresis + cooldown (prevents rapid flip noise)
function makeFacingController(initial = 1) {
  let facing = initial as 1 | -1;
  let hold = 0;

  const FLIP_V = 6;     // px/s threshold to auto-flip from velocity
  const HOLD_T = 0.10;  // seconds after a flip before allowing another

  return {
    get() {
      return facing;
    },
    tick(dt: number, vx: number, preferDir: number | 0) {
      hold = Math.max(0, hold - dt);

      // preferDir wins immediately (player input / puppet intent)
      if (preferDir !== 0) {
        facing = preferDir < 0 ? -1 : 1;
        hold = HOLD_T;
        return facing;
      }

      // otherwise only flip from velocity when not in hold window
      if (hold > 0) return facing;

      if (vx <= -FLIP_V) {
        if (facing !== -1) hold = HOLD_T;
        facing = -1;
      } else if (vx >= FLIP_V) {
        if (facing !== 1) hold = HOLD_T;
        facing = 1;
      }

      return facing;
    },
  };
}

function isPushingWall(
  a: AABB,
  dir: -1 | 1,
  isSolidTile: SolidTileQuery,
  world: WorldInfo
) {
  // Treat WORLD/CANVAS edges as solid walls
  const EPS = 0.001;

  if (dir < 0) {
    if (a.x <= 0 + EPS) return true;
  } else {
    if (a.x + a.w >= world.w - EPS) return true;
  }

  // Tile probe just outside the side
  const tw = world.tw | 0;
  const th = world.th | 0;

  const px = dir > 0 ? (a.x + a.w) : (a.x - 1);

  if (px < 0 || px >= world.w) return true;

  const y0 = (a.y + 2) | 0;
  const y1 = (a.y + (a.h >> 1)) | 0;
  const y2 = (a.y + a.h - 3) | 0;

  const tx = (px / tw) | 0;
  if (tx < 0 || tx >= world.tilesW) return true;

  const ty0 = (y0 / th) | 0;
  const ty1 = (y1 / th) | 0;
  const ty2 = (y2 / th) | 0;

  if (ty0 < 0 || ty0 >= world.tilesH) return true;
  if (ty1 < 0 || ty1 >= world.tilesH) return true;
  if (ty2 < 0 || ty2 >= world.tilesH) return true;

  return isSolidTile(tx, ty0) || isSolidTile(tx, ty1) || isSolidTile(tx, ty2);
}

export async function createGooseEntity(opts?: {
  x?: number;
  y?: number;
  scale?: number;
  controllable?: boolean;
}): Promise<Player> {
  const scale = opts?.scale ?? 1;

  const target = Math.max(12, (32 * scale + 0.5) | 0);
  const OUT_W = snapBakeSize(target);
  const OUT_H = OUT_W;

  const baked = await getBakedForSize(OUT_W, OUT_H);
  const idleFrames = baked.idle;
  const walkFrames = baked.walk;
  const flapFrames = baked.flap;

  const RUN_MAX = 90;
  const RUN_ACCEL = 900;
  const RUN_DECEL = 1300;

  const JUMP_V = 260;
  const COYOTE_T = 0.08;
  const JUMP_BUF_T = 0.1;

  const GROUND_GRACE_T = 0.05;

  const physTune = defaultPhysicsTuning();
  const physState: PhysicsState = {
    grounded: false,
    hitCeil: false,
    hitLeft: false,
    hitRight: false,
  };

  let state: MoveState = "groundIdle";

  let anim: AnimName = "idle";
  let frame = 0;
  let at = 0;

  const animLen: Record<AnimName, number> = { idle: 2, walk: 4, flap: 2 };
  const animRate: Record<AnimName, number> = { idle: 3.5, walk: 10.0, flap: 9.0 };

  let coyote = 0;
  let jumpBuf = 0;
  let jumpLatch = false;

  let puppetJumpLatch = true;
  let groundGrace = 0;

  // --- PUPPET DIR LATCH (prevents wild flipping when master is pinned)
  let puppetDir: -1 | 0 | 1 = 1;
  let puppetDirHold = 0;

  // latch last meaningful speed too (so we can keep moving when masterDx becomes 0)
  let puppetSpeed = 0;       // px/s (positive magnitude)
  let puppetSpeedHold = 0;

  // hysteresis thresholds in px/s
  const DIR_ON = 10;        // must exceed this to set a new dir
  const DIR_OFF = 4;        // below this we *may* clear dir (if not held)
  const DIR_HOLD_T = 0.25;  // keep last dir for this long after a strong signal

  // speed latch
  const SPEED_MIN = 18;       // minimum “keep walking” speed once latched
  const SPEED_HOLD_T = 0.25;  // seconds to keep latched speed after signal drops


  const body: AABB = {
    x: opts?.x ?? 24,
    y: opts?.y ?? 24,
    w: OUT_W,
    h: OUT_H,
    vx: 0,
    vy: 0,
  };

  const controllable = opts?.controllable ?? true;
  const sticky = makeStickySnap(0.22);
  const face = makeFacingController(1);

  type DebugState = {
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
  };

  const dbg: DebugState = {
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

  function syncDbg() {
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
  }

  function logTransition(kind: string, extra?: string) {
    console.log(
      `[${dbg.id}${controllable ? ":P" : ":B"}] ${kind} ` +
        `st=${state} an=${anim}:${frame} g=${physState.grounded ? 1 : 0}(gr=${groundGrace.toFixed(2)}) ` +
        `hit(LR C)=(${physState.hitLeft ? 1 : 0}${physState.hitRight ? 1 : 0} ${physState.hitCeil ? 1 : 0}) ` +
        `v=(${body.vx.toFixed(1)},${body.vy.toFixed(1)}) ` +
        (extra ?? "")
    );
  }

  function setAnim(next: AnimName) {
    if (anim === next) return;
    anim = next;
    frame = 0;
    at = 0;
    logTransition("ANIM->", next);
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

    logTransition("STATE->", next);
  }

  function groundedStable(dt: number) {
    if (physState.grounded) groundGrace = GROUND_GRACE_T;
    else groundGrace = Math.max(0, groundGrace - dt);
    return physState.grounded || groundGrace > 0;
  }

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
      logTransition("JUMP!");
    }

    stepTileAabbPhysics(body, physState, dt, isSolidTile, world, physTune);

    const onGround = groundedStable(dt);

    if (!onGround) {
      setState("airFlap");
    } else if (ax === 0) {
      setState("groundIdle");
    } else {
      const dir = (ax < 0 ? -1 : 1) as -1 | 1;
      const pushingWall = isPushingWall(body, dir, isSolidTile, world);
      if (pushingWall) {
        body.vx = 0;
        setState("groundIdle");
      } else {
        setState("groundWalk");
      }
    }

    face.tick(dt, body.vx, ax as -1 | 0 | 1);

    tickAnim(dt);

    sticky.reset();
    syncDbg();
  }
  let puppetWalking = false;
  let puppetWalkHold = 0;

  // start/stop thresholds (px/s) for Game Boy-stable animation
  const PUPPET_WALK_ENTER = 10;   // start walking above this
  const PUPPET_WALK_EXIT  = 6;    // stop walking below this
  const PUPPET_WALK_MIN_T = 0.12; // once walking, keep for at least this long


// -----------------------------------------------------------------------------
// gooseEntity.ts (inside puppetStep) — ENTIRE FIXED SECTION
// -----------------------------------------------------------------------------
 function puppetStep(
  dt: number,
  masterDx: number,
  _masterDy: number,
  masterJump: boolean,
  isSolidTile: SolidTileQuery,
  world: WorldInfo
) {
  // Direction comes ONLY from player intent (sign of masterDx)
  const dir: -1 | 0 | 1 =
    masterDx < 0 ? -1 :
    masterDx > 0 ?  1 : 0;

  // Speed follows intent, but can be smoothed
  if (dir !== 0) {
    puppetSpeed = RUN_MAX;
  } else {
    puppetSpeed = Math.max(0, puppetSpeed - RUN_DECEL * dt);
  }

  // Apply velocity
  body.vx = dir * puppetSpeed;

  // Jump inherit (unchanged)
  if (masterJump && !puppetJumpLatch) {
    body.vy = Math.min(body.vy, -JUMP_V);
    puppetJumpLatch = true;
  }
  if (!masterJump) puppetJumpLatch = false;

  // Physics
  stepTileAabbPhysics(body, physState, dt, isSolidTile, world, physTune);

  // Ground grace
  if (physState.grounded) groundGrace = GROUND_GRACE_T;
  else groundGrace = Math.max(0, groundGrace - dt);
  const groundedStableNow = physState.grounded || groundGrace > 0;

  // Wall stop (does NOT affect direction)
  if (physState.hitLeft || physState.hitRight) {
    body.vx = 0;
  }

  // Facing = intent, never physics
  face.tick(dt, body.vx, dir);

  // Animation
  if (!groundedStableNow) {
    puppetWalking = false;
    puppetWalkHold = 0;
    setState("airFlap");
  } else if (dir === 0) {
    puppetWalking = false;
    setState("groundIdle");
  } else {
    puppetWalking = true;
    setState("groundWalk");
  }

  tickAnim(dt);
  void _masterDy;
  syncDbg();
}

  function draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }) {
    ctx.imageSmoothingEnabled = false;

    const frames = anim === "walk" ? walkFrames : anim === "flap" ? flapFrames : idleFrames;
    const img = frames[frame % frames.length];

    const rx = body.x - cam.x;
    const ry = body.y - cam.y;

    const snapped = controllable ? { x: rx | 0, y: ry | 0 } : sticky.snap(rx, ry);
    const dx = snapped.x;
    const dy = snapped.y;

    const facing = face.get();

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

    w: OUT_W,
    h: OUT_H,

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
