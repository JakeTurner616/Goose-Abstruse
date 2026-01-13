// src/goose/anim.ts
import type { AnimName } from "../spriteBake";

export type AnimCtrl = {
  get anim(): AnimName;
  get frame(): number;
  setAnim(next: AnimName): void;
  tick(dt: number): void;
};

export function createAnimCtrl(
  initial: AnimName,
  animLen: Record<AnimName, number>,
  animRate: Record<AnimName, number>,
  onChange?: (next: AnimName) => void
): AnimCtrl {
  let anim: AnimName = initial;
  let frame = 0;
  let at = 0;

  function setAnim(next: AnimName) {
    if (anim === next) return;
    anim = next;
    frame = 0;
    at = 0;
    onChange?.(next);
  }

  function tick(dt: number) {
    at += dt * animRate[anim];
    const adv = at | 0;
    if (!adv) return;
    at -= adv;
    frame = (frame + adv) % animLen[anim];
  }

  return {
    get anim() {
      return anim;
    },
    get frame() {
      return frame;
    },
    setAnim,
    tick,
  };
}
