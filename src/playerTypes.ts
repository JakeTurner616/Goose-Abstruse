// src/playerTypes.ts
export type Keys = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;

  a: boolean;
  b: boolean;

  start: boolean;
  select: boolean;

  // NEW
  r: boolean;
};



export type SolidTileQuery = (tx: number, ty: number) => boolean;

export type WorldInfo = {
  w: number; h: number;
  tw: number; th: number;
  tilesW: number; tilesH: number;
};

export type Player = {
  x: number;
  y: number;
  w: number;
  h: number;

  vx: number;
  vy: number;

  grounded: boolean;

  // normal controller step (goose)
  update(dt: number, keys: Keys, isSolidTile: SolidTileQuery, world: WorldInfo): void;

  // puppet step (gooselings): apply master displacement, but keep their own gravity;
  // masterJump = true when the goose *actually started a jump this frame*
  puppetStep(
    dt: number,
    masterDx: number,
    masterDy: number,
    masterJump: boolean,
    isSolidTile: SolidTileQuery,
    world: WorldInfo
  ): void;

  draw(ctx: CanvasRenderingContext2D, cam: { x: number; y: number }): void;
};

export const NO_KEYS: Keys = {
  left: false,
  right: false,
  up: false,
  down: false,

  a: false,
  b: false,

  start: false,
  select: false,

  r: false,
};