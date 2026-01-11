// src/goose/wallUnstick.ts
import type { AABB, PhysicsState } from "../playerPhysics";
import type { SolidTileQuery, WorldInfo } from "../playerTypes";

export type UnstickState = { catchT: number; cooldownT: number };

// Only consider unstick while clearly falling.
const FALL_UNSTICK_VY = 8;

// How long we must be "caught" (falling + side hit + no downward progress) before nudging.
const WALL_CATCH_T = 0.055;

// After we nudge, wait a moment before allowing another nudge (prevents oscillation).
const WALL_UNSTICK_COOLDOWN_T = 0.10;

// You're intentionally snapping bodies to integers for 1-bit stability.
export const snapBody = (b: AABB) => {
  b.x = Math.round(b.x);
  b.y = Math.round(b.y);
};

export function isPushingWall(a: AABB, dir: -1 | 1, solid: SolidTileQuery, world: WorldInfo) {
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
export function handleCornerCatchUnstick(
  dt: number,
  body: AABB,
  st: PhysicsState,
  solid: SolidTileQuery,
  world: WorldInfo,
  state: UnstickState,
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
