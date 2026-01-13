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

// expose this for collision-safe snapping (avoids snapBody rounding into walls)
export function aabbHitsTiles(a: { x: number; y: number; w: number; h: number }, solid: SolidTileQuery, world: WorldInfo) {
  return hits(a.x, a.y, a.w, a.h, solid, world);
}

function rowSolid(ty: number, x: number, w: number, solid: SolidTileQuery, world: WorldInfo) {
  const tw = world.tw | 0;
  const x0 = (x / tw) | 0,
    x1 = ((x + w - 1) / tw) | 0;
  for (let tx = x0; tx <= x1; tx++) if (solid(tx, ty)) return true;
  return false;
}

// Binary-search sweep to the furthest non-colliding position along X.
function sweepXToContact(a: AABB, nx: number, solid: SolidTileQuery, world: WorldInfo, iters = 10) {
  const start = a.x;
  if (nx === start) return start;

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

// Step-up must be "onto a ledge", not "into any empty pocket".
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

// -----------------------------------------------------------------------------
// Emergency depenetration (true “rare rescue”).
// Key changes vs previous:
// - NO velocity killing (prevents wall-fall slowdown)
// - NO grounded fiddling
// - smaller search radius (keeps motion smooth)
// -----------------------------------------------------------------------------
export function unstuckTileAabb(a: AABB, st: PhysicsState, solid: SolidTileQuery, world: WorldInfo) {
  if (!hits(a.x, a.y, a.w, a.h, solid, world)) return false;

  const ox = a.x;
  const oy = a.y;

  // Tight radius: if we're deeper than this, something else is wrong (spawn / map).
  const MAX_R = 4;

  // Prefer least-surprising axis moves. Up first (common snap/floor cases),
  // but DON'T force it if it would still collide.
  for (let r = 1; r <= MAX_R; r++) {
    // axis
    const cand = [
      [0, -r],
      [-r, 0],
      [r, 0],
      [0, r],
      // diagonals
      [-r, -r],
      [r, -r],
      [-r, r],
      [r, r],
    ] as const;

    for (let i = 0; i < cand.length; i++) {
      const dx = cand[i][0];
      const dy = cand[i][1];

      const nx = clamp(ox + dx, 0, world.w - a.w);
      const ny = clamp(oy + dy, 0, world.h - a.h);

      if (!hits(nx, ny, a.w, a.h, solid, world)) {
        a.x = nx;
        a.y = ny;
        return true;
      }
    }
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

  // only rescue if truly inside (doesn't change velocities)
  unstuckTileAabb(a, st, solid, world);

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

  // If we start in-solid, rescue (no velocity edits).
  unstuckTileAabb(a, st, solid, world);

  a.vy = Math.min(tuning.fallMax, a.vy + tuning.grav * dt);

  const steps = clamp(
    ((((Math.max(Math.abs(a.vx), Math.abs(a.vy)) * dt) / 8) | 0) || 1),
    1,
    tuning.maxSubSteps | 0
  );
  const sdt = dt / steps;

  const NUDGE = 1e-4;

  for (let i = 0; i < steps; i++) {
    const nx = a.x + a.vx * sdt;

    if (!hits(nx, a.y, a.w, a.h, solid, world)) {
      a.x = nx;
    } else {
      const dir = a.vx > 0 ? 1 : a.vx < 0 ? -1 : 0;

      if (!(dir && tryStepUp(a, nx, solid, world, tuning))) {
        const snapped = sweepXToContact(a, nx, solid, world);

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

  // only rescue if truly inside; does not change velocities
  unstuckTileAabb(a, st, solid, world);

  if (!st.grounded) st.grounded = hits(a.x, a.y + 1, a.w, a.h, solid, world);
}
