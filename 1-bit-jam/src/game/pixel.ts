// src/game/pixel.ts
import type { Player } from "../player";

export function snapToPixel(p: Player) {
  p.x = (p.x + 0.5) | 0;
  p.y = (p.y + 0.5) | 0;
}
