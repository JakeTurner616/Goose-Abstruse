// src/game/levelRuntime.ts
import { loadTiled, type TiledWorld, GID_MASK } from "../tiled";
import { createPlayer, createGooseEntity, type Player } from "../player";
import { loadKeyAtlas, createKeyEntity, type KeyEntity, type KeyAtlas } from "../key";

import { clamp } from "./math";
import { scanSpawnPoints, type SpawnPoint } from "./spawn";
import { snapToPixel } from "./pixel";
import { assetUrl } from "../assetUrl";

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

  // restart current level instantly (no LOADING flash)
  restartLevel(): void;

  // warm up the next level during win hold so the swap is instant
  preloadNextLevel(): void;

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

type PreparedLevel = {
  idx: number;
  world: TiledWorld;

  // spawn-derived state
  startX: number;
  startY: number;

  keysTotal: number;
  key: KeyEntity | null;
  gooselings: Player[];
};

export function createLevelRuntime(opts: CreateLevelRuntimeOpts): LevelRuntime {
  const LEVELS = (
    opts.levels?.length
      ? opts.levels
      : [
          "./Tiled/level1.tmx",
          "./Tiled/level2.tmx",
          "./Tiled/level3.tmx",
          "./Tiled/level4.tmx",
          "./Tiled/level5.tmx",
          "./Tiled/level6.tmx",
          "./Tiled/level7.tmx",
        ]
  ).slice();

  let levelIndex = clamp(opts.startLevel ?? 0, 0, Math.max(0, LEVELS.length - 1)) | 0;

  // "visible" loading (used for boot/death/manual loads)
  let loadingLevel = false;

  let world: TiledWorld | null = null;
  let player!: Player;
  const gooselings: Player[] = [];

  let keyAtlas: KeyAtlas | null = null;
  let key: KeyEntity | null = null;

  let keysTotal = 0;
  let keysCollected = 0;

  // Cache spawn points for the CURRENT applied world so restart is instant.
  let curSpawns: SpawnPoint[] | null = null;

  // "hidden" prepared next-level state (built during win hold)
  let prepared: PreparedLevel | null = null;
  let preparingIdx: number | null = null;
  let preparingPromise: Promise<void> | null = null;

  // guards against stale async loads completing late and overwriting newer loads
  let loadToken = 0;

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

  function ensureAndResetGooselings(points: SpawnPoint[]) {
    // Fast path: reuse existing entities so restart is instant.
    const babies = points.filter((p) => p.kind === "gooseling");
    const n = babies.length | 0;

    // If counts mismatch, fall back to async rebuild (still no LOADING message).
    if (gooselings.length !== n) {
      loadingLevel = true;
      (async () => {
        try {
          await spawnGooselings(points);
        } finally {
          loadingLevel = false;
          // After rebuild, we should refresh camera targets.
          opts.onEntitiesPlaced(player, gooselings);
        }
      })();
      return;
    }

    for (let i = 0; i < n; i++) {
      const p = babies[i];
      const b = gooselings[i];
      b.x = p.x;
      b.y = p.y;
      b.vx = 0;
      b.vy = 0;
      snapToPixel(b);
    }
  }

  function buildKeyEntity(nextWorld: TiledWorld, points: SpawnPoint[]) {
    if (!keyAtlas) return null;
    const kp = points.find((s) => s.kind === "key");
    if (!kp) return null;

    const tw = nextWorld.map.tw;
    const th = nextWorld.map.th;
    return createKeyEntity(keyAtlas, { x: kp.x + (tw >> 1), y: kp.y + th, scale: 1, fps: 14 });
  }

  async function buildPrepared(idx: number): Promise<PreparedLevel> {
    const url = LEVELS[idx];
    const nextWorld = await loadTiled(url);
    const sp = scanSpawnPoints(nextWorld);

    // player start
    let startX = 24;
    let startY = 0;
    const goose = sp.find((s) => s.kind === "goose");
    if (goose) {
      startX = goose.x;
      startY = goose.y;
    }

    // babies (build NEW entities off to the side; do not touch live arrays)
    const babyPoints = sp.filter((p) => p.kind === "gooseling");
    const babies = babyPoints.length
      ? await Promise.all(
          babyPoints.map((p) =>
            createGooseEntity({
              x: p.x,
              y: p.y,
              scale: 0.65,
              controllable: false,
            })
          )
        )
      : [];

    for (const b of babies) snapToPixel(b);

    const kt = sp.filter((s) => s.kind === "key").length | 0;
    const k = buildKeyEntity(nextWorld, sp);

    return {
      idx,
      world: nextWorld,
      startX,
      startY,
      keysTotal: kt,
      key: k,
      gooselings: babies,
    };
  }

  function applyPrepared(p: PreparedLevel) {
    world = p.world;
    curSpawns = scanSpawnPoints(p.world);
    opts.onWorldApplied(p.world);

    // counters
    keysTotal = p.keysTotal | 0;
    keysCollected = 0;

    // player (reuse the same instance)
    player.x = p.startX;
    player.y = p.startY;
    player.vx = 0;
    player.vy = 0;
    snapToPixel(player);

    // swap babies
    gooselings.length = 0;
    gooselings.push(...p.gooselings);

    // swap key
    key = p.key ?? null;

    // lifecycle hooks
    opts.onResetForNewLevel();
    opts.onEntitiesPlaced(player, gooselings);
  }

  async function applyLoadedWorld(nextWorld: TiledWorld) {
    world = nextWorld;
    curSpawns = scanSpawnPoints(nextWorld);
    opts.onWorldApplied(nextWorld);

    const sp = curSpawns;

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
    key = buildKeyEntity(nextWorld, sp);

    opts.onResetForNewLevel();
    opts.onEntitiesPlaced(player, gooselings);
  }

  function restartLevel() {
    if (!world) return;

    const sp = curSpawns ?? (curSpawns = scanSpawnPoints(world));

    // counters (restart should reset collection)
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

    // babies: reuse entities when possible (instant)
    ensureAndResetGooselings(sp);

    // key: respawn at first key spawn
    key = buildKeyEntity(world, sp);

    opts.onResetForNewLevel();
    opts.onEntitiesPlaced(player, gooselings);
  }

  function clearPrepared() {
    prepared = null;
    preparingIdx = null;
    preparingPromise = null;
  }

  function preloadNextLevel() {
    if (!LEVELS.length) return;
    if (loadingLevel) return; // don't compete with visible loads

    const nextIdx = ((levelIndex + 1) % LEVELS.length) | 0;

    if (prepared && prepared.idx === nextIdx) return;
    if (preparingIdx === nextIdx && preparingPromise) return;

    preparingIdx = nextIdx;
    preparingPromise = (async () => {
      try {
        const p = await buildPrepared(nextIdx);
        if (preparingIdx === nextIdx) prepared = p;
      } catch {
        if (preparingIdx === nextIdx) prepared = null;
      } finally {
        if (preparingIdx === nextIdx) {
          preparingIdx = null;
          preparingPromise = null;
        }
      }
    })();
  }

  function loadLevel(i: number) {
    if (!LEVELS.length) return;

    const idx = clamp(i | 0, 0, LEVELS.length - 1) | 0;
    levelIndex = idx;

    // If we have a fully prepared level for this index, swap instantly (no LOADING...)
    if (prepared && prepared.idx === idx) {
      const p = prepared;
      clearPrepared();
      applyPrepared(p);
      return;
    }

    const myToken = ++loadToken;

    loadingLevel = true;
    opts.setUiMessage("LOADING...");

    preparingIdx = null;

    (async () => {
      try {
        const url = LEVELS[idx];
        const nextWorld = await loadTiled(url);

        if (myToken !== loadToken) return;

        await applyLoadedWorld(nextWorld);
      } catch (err) {
        if (myToken !== loadToken) return;
        console.error(err);
        opts.setUiMessage("LOAD FAILED");
      } finally {
        if (myToken !== loadToken) return;
        loadingLevel = false;
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
      loadKeyAtlas(assetUrl((opts.keyAtlasPath ?? "Key/").replace(/^\/+/, ""))).catch(() => null),
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
    restartLevel,
    preloadNextLevel,

    init,
  };
}
