// src/goose/facing.ts
export type Facing = {
  get(): 1 | -1;
  tick(dt: number, vx: number, prefer: -1 | 0 | 1): 1 | -1;
};

// facing with hysteresis + cooldown (prevents rapid flip noise)
export function makeFacing(initial: 1 | -1 = 1): Facing {
  let f: 1 | -1 = initial;
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
