/**
 * bootstrap.ts — Ciclo di bootstrap deterministico e unificato per il runtime Hexagon.
 *
 * Sequenza canonica condivisa tra avvio plugin (bootstrapRuntime) e tool manuale (hexagon_sync):
 *   1. Pre-check runtime (+ stopServer scoped se necessario aggiornare i binari)
 *   2. ensureRuntime (con -NoStopServer per evitare doppi riavvii o kill di server Direct)
 *   3. ensureModelsIni / syncDiscoveredModelsToIni (propagando CERTIFIED/INCOMPATIBLE)
 *   4. ensureServer
 *   5. waitForHealth
 *   6. reloadServerIfStale (solo se server gia' attivo, e solo su Router gestito verificato)
 *      + waitForHealth post-reload se riavviato
 */
import {
  syncDiscoveredModelsToIni,
  type SyncModelsResult,
} from "./discovery.js";
import { waitForHealth, type HealthResult } from "./health.js";
import {
  ensureModelsIni,
  ensureServer,
  reloadServerIfStale,
  ROUTER_HOST,
  ROUTER_PORT,
  stopServer,
  type EnsureIniResult,
  type EnsureServerResult,
  type ReloadIfStaleResult,
} from "./process.js";
import {
  checkRuntime,
  ensureRuntime,
  type RuntimePaths,
  type SyncOutcome,
} from "./sync.js";
import type {
  ExecFn,
  ExistsFn,
  FetchFn,
  ListDirFn,
  MkdirFn,
  NowFn,
  ReadFileFn,
  SleepFn,
  SpawnFn,
  WriteFileFn,
} from "./types.js";

export interface BootstrapCycleDeps {
  exec: ExecFn;
  fetch: FetchFn;
  spawn?: SpawnFn;
  exists: ExistsFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  listDir?: ListDirFn;
  mkdir?: MkdirFn;
  sleep?: SleepFn;
  now?: NowFn;
}

export interface BootstrapCycleOptions {
  workspaceDir: string;
  runtimeDir: string;
  geniexDir: string;
  geniexExe: string;
  serverExe: string;
  modelsDir: string;
  iniPath: string;
  registryPath?: string;
  configDir?: string;
  host?: string;
  port?: number;
  forceSync?: boolean;
  ignoreIniErrors?: boolean;
  ignoreCatalogErrors?: boolean;
  ignoreServerErrors?: boolean;
  deps: BootstrapCycleDeps;
  syncFn?: (options: { force?: boolean; stopServer?: boolean }) => Promise<SyncOutcome>;
}

export interface BootstrapCycleResult {
  sync: SyncOutcome;
  ini: EnsureIniResult;
  catalog: SyncModelsResult;
  server: EnsureServerResult;
  health?: HealthResult;
  reload: ReloadIfStaleResult;
}

const EMPTY_CATALOG: SyncModelsResult = {
  addedModels: [],
  removedModels: [],
  totalModels: 0,
  iniUpdated: false,
};

const NO_RELOAD: ReloadIfStaleResult = {
  reloaded: false,
  reason: "Nessun reload richiesto",
  missingModels: [],
  staleModels: [],
};

export async function runBootstrapCycle(
  options: BootstrapCycleOptions,
): Promise<BootstrapCycleResult> {
  const { deps } = options;
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  const runtimePaths: RuntimePaths = {
    geniexExe: options.geniexExe,
    llamaServerExe: options.serverExe,
    runtimeDir: options.runtimeDir,
  };

  let stoppedManagedForSync = false;
  let sync: SyncOutcome;

  try {
    if (options.syncFn) {
      if (options.forceSync) {
        stoppedManagedForSync = await stopServer({
          exec: deps.exec,
          serverExe: options.serverExe,
          iniPath: options.iniPath,
          modelsDir: options.modelsDir,
          host,
          port,
        });
      }
      sync = await options.syncFn({ force: options.forceSync });
    } else {
      const listDir = deps.listDir ?? (async () => []);
      const syncDeps = { exec: deps.exec, exists: deps.exists, listDir };
      const before = await checkRuntime(runtimePaths, syncDeps, {
        workspaceDir: options.workspaceDir,
        geniexDir: options.geniexDir,
      });

      if (options.forceSync || before.needsSync) {
        stoppedManagedForSync = await stopServer({
          exec: deps.exec,
          serverExe: options.serverExe,
          iniPath: options.iniPath,
          modelsDir: options.modelsDir,
          host,
          port,
        });
        sync = await ensureRuntime({
          paths: runtimePaths,
          workspaceDir: options.workspaceDir,
          binPath: options.runtimeDir,
          geniexDir: options.geniexDir,
          force: true,
          stopServer: false,
          beforeCheck: before,
          deps: syncDeps,
        });
      } else {
        sync = {
          updated: false,
          message: "Runtime gia' allineato al commit GenieX",
          files: [],
          check: before,
        };
      }
    }
  } catch (err) {
    if (stoppedManagedForSync && deps.spawn) {
      await ensureServer({
        fetch: deps.fetch,
        spawn: deps.spawn,
        runtimeDir: options.runtimeDir,
        serverExe: options.serverExe,
        iniPath: options.iniPath,
        modelsDir: options.modelsDir,
        host,
        port,
      }).catch(() => {});
    }
    throw err;
  }

  let ini: EnsureIniResult = { generated: false, modelCount: 0 };
  let catalog: SyncModelsResult = { ...EMPTY_CATALOG };

  if (deps.writeFile) {
    const iniPromise = ensureModelsIni({
      iniPath: options.iniPath,
      workspaceDir: options.workspaceDir,
      modelsDir: options.modelsDir,
      exec: deps.exec,
      exists: deps.exists,
      writeFile: deps.writeFile,
      readFile: deps.readFile,
      listDir: deps.listDir,
      mkdir: deps.mkdir,
      registryPath: options.registryPath,
    });
    ini = options.ignoreIniErrors
      ? await iniPromise.catch(() => ({ generated: false, modelCount: 0 }))
      : await iniPromise;

    if (!ini.generated && deps.listDir) {
      const syncPromise = syncDiscoveredModelsToIni({
        modelsDir: options.modelsDir,
        iniPath: options.iniPath,
        workspaceDir: options.workspaceDir,
        configDir: options.configDir,
        registryPath: options.registryPath,
        deps: {
          listDir: deps.listDir,
          exists: deps.exists,
          readFile: deps.readFile,
          writeFile: deps.writeFile,
          exec: deps.exec,
          mkdir: deps.mkdir,
        },
      });
      catalog = options.ignoreCatalogErrors
        ? await syncPromise.catch(() => ({ ...EMPTY_CATALOG }))
        : await syncPromise;
    }
  }

  let server: EnsureServerResult = {
    started: false,
    reason: "spawn non configurato",
  };
  if (deps.spawn) {
    const startPromise = ensureServer({
      fetch: deps.fetch,
      spawn: deps.spawn,
      runtimeDir: options.runtimeDir,
      serverExe: options.serverExe,
      iniPath: options.iniPath,
      modelsDir: options.modelsDir,
      host,
      port,
    });
    server = options.ignoreServerErrors
      ? await startPromise.catch((err) => ({
          started: false,
          reason: err instanceof Error ? err.message : String(err),
        }))
      : await startPromise;
  }

  const healthUrl = `http://${host}:${port}/health`;
  const healthPromise = waitForHealth({
    fetch: deps.fetch,
    url: healthUrl,
    sleep: deps.sleep,
    now: deps.now,
  });
  let health: HealthResult | undefined = options.ignoreServerErrors
    ? await healthPromise.catch(() => undefined)
    : await healthPromise;

  let reload: ReloadIfStaleResult = { ...NO_RELOAD };
  if (!server.started && deps.spawn) {
    const reloadPromise = reloadServerIfStale({
      fetch: deps.fetch,
      spawn: deps.spawn,
      exec: deps.exec,
      readFile: deps.readFile,
      sleep: deps.sleep,
      runtimeDir: options.runtimeDir,
      serverExe: options.serverExe,
      iniPath: options.iniPath,
      modelsDir: options.modelsDir,
      host,
      port,
    });
    reload = options.ignoreServerErrors
      ? await reloadPromise.catch((err) => ({
          reloaded: false,
          reason: err instanceof Error ? err.message : String(err),
          missingModels: [],
          staleModels: [],
        }))
      : await reloadPromise.catch(() => ({ ...NO_RELOAD }));

    if (reload.reloaded) {
      const postReloadHealth = waitForHealth({
        fetch: deps.fetch,
        url: healthUrl,
        sleep: deps.sleep,
        now: deps.now,
      });
      health = options.ignoreServerErrors
        ? await postReloadHealth.catch(() => undefined)
        : await postReloadHealth;
    }
  }

  return { sync, ini, catalog, server, ...(health ? { health } : {}), reload };
}
