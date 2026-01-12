// src/gooseEntity.ts
import { type AABB, type PhysicsState, defaultPhysicsTuning, stepTileAabbPhysics } from "./playerPhysics";
import type { Keys, Player, SolidTileQuery, WorldInfo } from "./playerTypes";
import { NO_KEYS } from "./playerTypes";
import { getBakedForSize, type AnimName } from "./spriteBake";

import { makeFacing } from "./goose/facing";
import { createAnimCtrl } from "./goose/anim";
import { handleCornerCatchUnstick, isPushingWall, snapBody, type UnstickState } from "./goose/wallUnstick";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

type MoveState = "groundIdle" | "groundWalk" | "airFlap";

const DEBUG = true;

const snapBakeSize = (px: number) => (px >= 30 ? 32 : px >= 22 ? 24 : px >= 14 ? 16 : 12);

// Small threshold so we don't "walk" when vx got killed by collision but input is held.
const MOVE_EPS = 0.75;

export async function createGooseEntity(opts?: {
  x?: number;
  y?: number;
  scale?: number;
  controllable?: boolean;
}): Promise<Player> {
  const scale = opts?.scale ?? 1;
  const out = snapBakeSize(Math.max(12, ((32 * scale + 0.5) | 0)));
  const baked = await getBakedForSize(out, out);

  const RUN_MAX = 70,
    RUN_ACCEL = 900,
    RUN_DECEL = 1300;
  const JUMP_V = 260,
    JUMP_BUF_T = 0.10,
    GROUND_GRACE_T = 0.05;
  const BABY_SPEED_MULT = 0.85;

  const physTune = defaultPhysicsTuning();
  const physState: PhysicsState = { grounded: false, hitCeil: false, hitLeft: false, hitRight: false };

  let state: MoveState = "groundIdle";

  const animLen: Record<AnimName, number> = { idle: 2, walk: 4, flap: 2 };
  const animRate: Record<AnimName, number> = { idle: 3.5, walk: 10.0, flap: 9.0 };

  const controllable = opts?.controllable ?? true;
  const face = makeFacing(1);

  const body: AABB = {
    x: opts?.x ?? 24,
    y: opts?.y ?? 24,
    w: out,
    h: out,
    vx: 0,
    vy: 0,
  };

  const unstick: UnstickState = { catchT: 0, cooldownT: 0 };

  let jumpBuf = 0,
    jumpLatch = false;
  let puppetJumpLatch = false; // only blocks repeat while held; actual jump eligibility is grounded/grace
  let groundGrace = 0;
  let puppetSpeed = 0;

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
    anim: "idle",
    frame: 0,
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

  const log = (kind: string, extra?: string) => {
    if (!DEBUG) return;
    console.log(
      `[${dbg.id}${controllable ? ":P" : ":B"}] ${kind} ` +
        `st=${state} an=${animCtrl.anim}:${animCtrl.frame} g=${physState.grounded ? 1 : 0}(gr=${groundGrace.toFixed(
          2
        )}) ` +
        `hit(LR C)=(${physState.hitLeft ? 1 : 0}${physState.hitRight ? 1 : 0} ${physState.hitCeil ? 1 : 0}) ` +
        `v=(${body.vx.toFixed(1)},${body.vy.toFixed(1)}) ` +
        (extra ?? "")
    );
  };

  const animCtrl = createAnimCtrl("idle", animLen, animRate, (next) => log("ANIM->", next));

  const setState = (next: MoveState) => {
    if (state === next) return;
    state = next;
    animCtrl.setAnim(state === "airFlap" ? "flap" : state === "groundWalk" ? "walk" : "idle");
    log("STATE->", next);
  };

  const syncDbg = () => {
    dbg.state = state;
    dbg.anim = animCtrl.anim;
    dbg.frame = animCtrl.frame;
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

  function update(dt: number, keys: Keys, solid: SolidTileQuery, world: WorldInfo) {
    const k = controllable ? keys : (NO_KEYS as Keys);

    // --- ground grace (coyote) is evaluated BEFORE we consume buffered jump
    groundGrace = physState.grounded ? GROUND_GRACE_T : Math.max(0, groundGrace - dt);
    const canJumpNow = physState.grounded || groundGrace > 0;

    // jump buffer (press)
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

    // --- consume buffered jump ONLY if grounded/grace (no double-jumps)
    if (jumpBuf > 0 && canJumpNow) {
      jumpBuf = 0;
      groundGrace = 0; // spend grace immediately so you can't "chain" via buffer timing
      body.vy = -JUMP_V;
      log("JUMP!");
    }

    // physics then snap + (rare) corner-unstick
    const preY = body.y;
    stepTileAabbPhysics(body, physState, dt, solid, world, physTune);
    snapBody(body);
    handleCornerCatchUnstick(dt, body, physState, solid, world, unstick, preY);

    // refresh grace if we landed this frame (do NOT decay twice)
    if (physState.grounded) groundGrace = GROUND_GRACE_T;
    const onGround = physState.grounded || groundGrace > 0;

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
    animCtrl.tick(dt);
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
    // grace (coyote) for puppet
    groundGrace = physState.grounded ? GROUND_GRACE_T : Math.max(0, groundGrace - dt);
    const canJumpNow = physState.grounded || groundGrace > 0;

    const dir: -1 | 0 | 1 = masterDx < 0 ? -1 : masterDx > 0 ? 1 : 0;

    if (dir !== 0 && DEBUG) log("PUPPET_INPUT", `masterDx: ${masterDx} | dir: ${dir}`);

    const pushingWall = dir !== 0 && isPushingWall(body, dir as -1 | 1, solid, world);
    const target = dir === 0 ? 0 : RUN_MAX * BABY_SPEED_MULT;

    const accel = target > puppetSpeed ? RUN_ACCEL : RUN_DECEL;
    const dv = accel * dt;
    puppetSpeed = puppetSpeed < target ? Math.min(target, puppetSpeed + dv) : Math.max(target, puppetSpeed - dv);

    body.vx = dir * puppetSpeed;

    // --- no midair repeat: require grounded/grace + edge latch
    if (masterJump && !puppetJumpLatch && canJumpNow) {
      groundGrace = 0;
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
        `vx: ${body.vx.toFixed(2)} | moved: ${(body.x - preX).toFixed(2)} | hitL: ${physState.hitLeft} | hitR: ${
          physState.hitRight
        }`
      );

    if (physState.grounded) groundGrace = GROUND_GRACE_T;
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

    animCtrl.tick(dt);
    syncDbg();
  }

  function draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }) {
    ctx.imageSmoothingEnabled = false;

    const anim = animCtrl.anim;
    const frame = animCtrl.frame;

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
