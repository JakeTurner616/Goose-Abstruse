// src/playerPhysics.ts
export type SolidTileQuery = (tx: number, ty: number) => boolean;

export type AABB = { x: number; y: number; w: number; h: number; vx: number; vy: number };

export type PhysicsTuning = {
  grav: number;
  fallMax: number;
  stepUp: number;
  snapDown: number;
  maxSubSteps: number;
};

export type PhysicsState = { grounded: boolean; hitCeil: boolean; hitLeft: boolean; hitRight: boolean };

export type WorldInfo = { w: number; h: number; tw: number; th: number; tilesW: number; tilesH: number };

export function defaultPhysicsTuning(): PhysicsTuning {
  return { grav: 780, fallMax: 160, stepUp: 3, snapDown: 4, maxSubSteps: 4 };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const resetState = (st: PhysicsState) => {
  st.grounded = st.hitCeil = st.hitLeft = st.hitRight = false;
};

function hits(x: number, y: number, w: number, h: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0,
    th = world.th | 0;

  const x0 = (x / tw) | 0,
    y0 = (y / th) | 0;
  const x1 = ((x + w - 1) / tw) | 0,
    y1 = ((y + h - 1) / th) | 0;

  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (solid(tx, ty)) return true;
  return false;
}

function colSolid(tx: number, y: number, h: number, solid: SolidTileQuery, world: WorldInfo) {
  const th = world.th | 0;
  const y0 = (y / th) | 0,
    y1 = ((y + h - 1) / th) | 0;
  for (let ty = y0; ty <= y1; ty++) if (solid(tx, ty)) return true;
  return false;
}

function rowSolid(ty: number, x: number, w: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0;
  const x0 = (x / tw) | 0,
    x1 = ((x + w - 1) / tw) | 0;
  for (let tx = x0; tx <= x1; tx++) if (solid(tx, ty)) return true;
  return false;
}

// Binary-search sweep to the furthest non-colliding position along X.
// Note: caller may apply a small "nudge" away from contact after this.
function sweepXToContact(a: AABB, nx: number, solid: SolidTileQuery, world: WorldInfo, iters = 10) {
  const start = a.x;
  if (nx === start) return start;

  // If we are already colliding, don't attempt to solve here.
  if (hits(start, a.y, a.w, a.h, solid, world)) return start;

  if (!hits(nx, a.y, a.w, a.h, solid, world)) return nx;

  let free = start;
  let blocked = nx;

  for (let i = 0; i < iters; i++) {
    const mid = (free + blocked) * 0.5;
    if (!hits(mid, a.y, a.w, a.h, solid, world)) free = mid;
    else blocked = mid;
  }

  return free;
}

function sweepYToContact(a: AABB, ny: number, solid: SolidTileQuery, world: WorldInfo, iters = 10) {
  const start = a.y;
  if (ny === start) return start;

  if (hits(a.x, start, a.w, a.h, solid, world)) return start;
  if (!hits(a.x, ny, a.w, a.h, solid, world)) return ny;

  let free = start;
  let blocked = ny;

  for (let i = 0; i < iters; i++) {
    const mid = (free + blocked) * 0.5;
    if (!hits(a.x, mid, a.w, a.h, solid, world)) free = mid;
    else blocked = mid;
  }

  return free;
}

// FIXED: Step-up must be "onto a ledge", not "into any empty pocket".
function tryStepUp(a: AABB, nx: number, solid: SolidTileQuery, world: WorldInfo, tuning: PhysicsTuning) {
  const maxUp = tuning.stepUp | 0;
  if (maxUp <= 0) return false;

  if (!hits(a.x, a.y + 1, a.w, a.h, solid, world)) return false;

  const th = world.th | 0;

  for (let up = 1; up <= maxUp; up++) {
    const ny = a.y - up;
    if (ny < 0) break;

    if (hits(nx, ny, a.w, a.h, solid, world)) continue;
    if (!hits(nx, ny + 1, a.w, a.h, solid, world)) continue;

    const headY = ny - 1;
    if (headY >= 0) {
      const headTy = (headY / th) | 0;
      if (rowSolid(headTy, nx, a.w, solid, world)) continue;
    }

    a.x = nx;
    a.y = ny;
    return true;
  }

  return false;
}

/** Kinematic move (no gravity). */
export function moveTileAabbKinematic(
  a: AABB,
  st: PhysicsState,
  dx: number,
  dy: number,
  solid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  resetState(st);

  const steps = clamp(((Math.max(Math.abs(dx), Math.abs(dy)) / 8) | 0) || 1, 1, tuning.maxSubSteps | 0);
  const sdx = dx / steps,
    sdy = dy / steps;

  const NUDGE = 1e-4;

  for (let i = 0; i < steps; i++) {
    // X
    if (sdx) {
      const nx = a.x + sdx;
      if (!hits(nx, a.y, a.w, a.h, solid, world)) a.x = nx;
      else {
        const dir = sdx > 0 ? 1 : -1;
        const snapped = sweepXToContact(a, nx, solid, world);
        a.x = snapped + (dir > 0 ? -NUDGE : NUDGE);
        if (dir > 0) st.hitRight = true;
        else st.hitLeft = true;
      }
    }

    // Y
    if (sdy) {
      const ny = a.y + sdy;
      if (!hits(a.x, ny, a.w, a.h, solid, world)) a.y = ny;
      else {
        const dir = sdy > 0 ? 1 : -1;
        const snapped = sweepYToContact(a, ny, solid, world);
        a.y = snapped + (dir > 0 ? -NUDGE : NUDGE);
        if (dir > 0) st.grounded = true;
        else st.hitCeil = true;
      }
    }

    // snap-down glue
    if (!st.grounded && sdy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (hits(a.x, a.y + d, a.w, a.h, solid, world)) {
          a.y = a.y + d - 1;
          st.grounded = true;
          break;
        }
      }
    }

    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  if (!st.grounded) st.grounded = hits(a.x, a.y + 1, a.w, a.h, solid, world);
}

/** Platformer physics step. */
export function stepTileAabbPhysics(
  a: AABB,
  st: PhysicsState,
  dt: number,
  solid: SolidTileQuery,
  world: WorldInfo,
  tuning: PhysicsTuning
) {
  resetState(st);

  a.vy = Math.min(tuning.fallMax, a.vy + tuning.grav * dt);

  const steps = clamp(
    ((((Math.max(Math.abs(a.vx), Math.abs(a.vy)) * dt) / 8) | 0) || 1),
    1,
    tuning.maxSubSteps | 0
  );
  const sdt = dt / steps;

  const NUDGE = 1e-4;

  for (let i = 0; i < steps; i++) {
    // X
    const nx = a.x + a.vx * sdt;

    if (!hits(nx, a.y, a.w, a.h, solid, world)) {
      a.x = nx;
    } else {
      const dir = a.vx > 0 ? 1 : a.vx < 0 ? -1 : 0;

      if (!(dir && tryStepUp(a, nx, solid, world, tuning))) {
        const snapped = sweepXToContact(a, nx, solid, world);

        // Nudge away so later pixel-snaps can't push us into the wall.
        if (dir > 0) {
          a.x = snapped - NUDGE;
          st.hitRight = true;
        } else if (dir < 0) {
          a.x = snapped + NUDGE;
          st.hitLeft = true;
        } else {
          a.x = snapped;
        }

        a.vx = 0;
      }
    }

    // Y
    const ny = a.y + a.vy * sdt;

    if (!hits(a.x, ny, a.w, a.h, solid, world)) {
      a.y = ny;
    } else {
      const dirY = a.vy > 0 ? 1 : a.vy < 0 ? -1 : 0;
      const snapped = sweepYToContact(a, ny, solid, world);

      if (dirY > 0) {
        a.y = snapped - NUDGE;
        st.grounded = true;
      } else if (dirY < 0) {
        a.y = snapped + NUDGE;
        st.hitCeil = true;
      } else {
        a.y = snapped;
      }

      a.vy = 0;
    }

    // snap-down glue (keep kill-vy)
    if (!st.grounded && a.vy >= 0 && (tuning.snapDown | 0) > 0) {
      const maxDown = tuning.snapDown | 0;
      for (let d = 1; d <= maxDown; d++) {
        if (hits(a.x, a.y + d, a.w, a.h, solid, world)) {
          a.y = a.y + d - 1;
          a.vy = 0;
          st.grounded = true;
          break;
        }
      }
    }

    a.x = clamp(a.x, 0, world.w - a.w);
    a.y = clamp(a.y, 0, world.h - a.h);
  }

  if (!st.grounded) st.grounded = hits(a.x, a.y + 1, a.w, a.h, solid, world);
}
