// src/player.ts
export type { Keys, SolidTileQuery, WorldInfo, Player } from "./playerTypes";
export { NO_KEYS } from "./playerTypes";
export { createGooseEntity } from "./gooseEntity";

import { createGooseEntity } from "./gooseEntity";
import type { Player } from "./playerTypes";

export function createPlayer(opts?: { x?: number; y?: number }): Promise<Player> {
  return createGooseEntity({ x: opts?.x, y: opts?.y, scale: 1, controllable: true });
}
