// src/game/levelRuntime.ts
import { loadTiled, type TiledWorld, GID_MASK } from "../tiled";
import { createPlayer, createGooseEntity, type Player } from "../player";
import { loadKeyAtlas, createKeyEntity, type KeyEntity, type KeyAtlas } from "../key";

import { clamp } from "./math";
import { scanSpawnPoints, type SpawnPoint } from "./spawn";
import { snapToPixel } from "./pixel";

export type LevelRuntime = {
  // world/entities
  get world(): TiledWorld | null;
  get player(): Player;
  get gooselings(): Player[];
  get key(): KeyEntity | null;

  // per-level counters
  get keysTotal(): number;
  get keysCollected(): number;
  incKeysCollected(): void;

  // key lifecycle
  consumeKey(): boolean;

  // loading + level list
  get loading(): boolean;
  get levelIndex(): number;
  get levelCount(): number;

  // tile query for physics
  isSolidTile(tx: number, ty: number): boolean;

  // level control
  loadLevel(i: number): void;
  nextLevel(): void;

  // called once at boot
  init(): Promise<void>;
};

export type CreateLevelRuntimeOpts = {
  levels?: string[];
  startLevel?: number;

  // assets
  keyAtlasPath?: string;

  // UI hook for loading indicator
  setUiMessage(msg: string): void;

  // called whenever a world is applied (lets camera module update bounds)
  onWorldApplied(world: TiledWorld): void;

  // called after entities are placed (lets camera reset targets/focus)
  onEntitiesPlaced(player: Player, gooselings: Player[]): void;

  // misc reset hook
  onResetForNewLevel(): void;
};

export function createLevelRuntime(opts: CreateLevelRuntimeOpts): LevelRuntime {
  const LEVELS = (opts.levels?.length ? opts.levels : ["/Tiled/level1.tmx", "/Tiled/level1 copy.tmx"]).slice();
  let levelIndex = clamp(opts.startLevel ?? 0, 0, Math.max(0, LEVELS.length - 1)) | 0;

  let loadingLevel = false;
  let pendingLoad: Promise<void> | null = null;

  let world: TiledWorld | null = null;
  let player!: Player;
  const gooselings: Player[] = [];

  let keyAtlas: KeyAtlas | null = null;
  let key: KeyEntity | null = null;

  let keysTotal = 0;
  let keysCollected = 0;

  function isSolidTile(tx: number, ty: number) {
    if (!world) return false;
    const { map } = world;
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return true;
    const gidRaw = (map as any).collide[ty * map.w + tx] >>> 0;
    return (gidRaw & GID_MASK) !== 0;
  }

  async function spawnGooselings(points: SpawnPoint[]) {
    gooselings.length = 0;
    const babies = points.filter((p) => p.kind === "gooseling");
    if (!babies.length) return;

    const made = await Promise.all(
      babies.map((p) =>
        createGooseEntity({
          x: p.x,
          y: p.y,
          scale: 0.65,
          controllable: false,
        })
      )
    );

    gooselings.push(...made);
    for (const b of gooselings) snapToPixel(b);
  }

  async function applyLoadedWorld(nextWorld: TiledWorld) {
    world = nextWorld;
    opts.onWorldApplied(nextWorld);

    const sp = scanSpawnPoints(nextWorld);

    keysTotal = sp.filter((s) => s.kind === "key").length | 0;
    keysCollected = 0;

    // player start
    let startX = 24;
    let startY = 0;
    const goose = sp.find((s) => s.kind === "goose");
    if (goose) {
      startX = goose.x;
      startY = goose.y;
    }

    player.x = startX;
    player.y = startY;
    player.vx = 0;
    player.vy = 0;
    snapToPixel(player);

    // babies
    await spawnGooselings(sp);

    // key entity (first key spawn)
    key = null;
    if (keyAtlas) {
      const kp = sp.find((s) => s.kind === "key");
      if (kp) {
        const tw = nextWorld.map.tw;
        const th = nextWorld.map.th;
        key = createKeyEntity(keyAtlas, { x: kp.x + (tw >> 1), y: kp.y + th, scale: 1, fps: 14 });
      }
    }

    opts.onResetForNewLevel();
    opts.onEntitiesPlaced(player, gooselings);
  }

  function loadLevel(i: number) {
    if (!LEVELS.length) return;

    const idx = clamp(i | 0, 0, LEVELS.length - 1) | 0;
    levelIndex = idx;

    if (loadingLevel) return;

    loadingLevel = true;
    opts.setUiMessage("LOADING...");

    const url = LEVELS[levelIndex];

    pendingLoad = (async () => {
      try {
        const next = await loadTiled(url);
        await applyLoadedWorld(next);
      } finally {
        loadingLevel = false;
        pendingLoad = null;
      }
    })();
  }

  function nextLevel() {
    if (!LEVELS.length) return;
    loadLevel(((levelIndex + 1) % LEVELS.length) | 0);
  }

  async function init() {
    const [p, firstWorld, ka] = await Promise.all([
      createPlayer({ x: 24, y: 24 }),
      loadTiled(LEVELS[levelIndex]),
      loadKeyAtlas(opts.keyAtlasPath ?? "/Key/").catch(() => null),
    ]);

    player = p;
    keyAtlas = ka;

    await applyLoadedWorld(firstWorld);
  }

  function incKeysCollected() {
    keysCollected = (keysCollected + 1) | 0;
  }

  function consumeKey() {
    if (!key) return false;
    key = null;
    return true;
  }

  return {
    get world() {
      return world;
    },
    get player() {
      return player;
    },
    get gooselings() {
      return gooselings;
    },
    get key() {
      return key;
    },

    get keysTotal() {
      return keysTotal | 0;
    },
    get keysCollected() {
      return keysCollected | 0;
    },
    incKeysCollected,

    consumeKey,

    get loading() {
      return loadingLevel;
    },
    get levelIndex() {
      return levelIndex | 0;
    },
    get levelCount() {
      return LEVELS.length | 0;
    },

    isSolidTile,

    loadLevel,
    nextLevel,

    init,
  };
}
