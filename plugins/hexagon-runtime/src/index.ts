/**
 * index.ts — Plugin Kilo nativo per il runtime Hexagon (Snapdragon X2 Elite).
 *
 * Default export conforme al contratto @kilocode/plugin v1:
 *   Plugin = (input: PluginInput) => Promise<Hooks>
 * Il descrittore { id, server } richiesto dal piano di pivot e' esposto come
 * export nominale per introspection e test.
 *
 * Hook:
 * - config: configurazione dinamica del provider hexagon (catalogo INI +
 *   contesti testati), senza scrittura di kilo.json;
 * - event/session.created: bootstrap del server locale (sync -> INI -> avvio
 *   -> health) e watchdog di recupero; session.deleted/server.instance.disposed
 *   fermano il watchdog quando non restano sessioni;
 * - chat.params: reasoning_effort "none" sui modelli locali (tool-calling deterministico);
 * - tool: hexagon_status, hexagon_sync, hexagon_bench.
 */
import type { Hooks, Plugin } from "@kilocode/plugin";
import { probeHealth, waitForHealth, type HealthResult } from "./health.js";
import {
  buildHexagonProvider,
  isLocalModel,
  LOCAL_PROVIDER_ID,
} from "./models.js";
import { nodeDeps } from "./os.js";
import {
  defaultPaths,
  ensureModelsIni,
  ensureServer,
  parseModelsIni,
  type EnsureIniResult,
  type EnsureServerResult,
  type ModelsIni,
} from "./process.js";
import { ensureRuntime, type SyncOutcome } from "./sync.js";
import { createHexagonTools } from "./tools.js";
import type { OsDeps } from "./types.js";
import {
  startWatchdog,
  type WatchdogHandle,
  type WatchdogOptions,
} from "./watchdog.js";
import {
  startModelWatcher,
  type ModelWatcher,
  type ModelWatcherOptions,
} from "./watcher.js";

export interface BootstrapResult {
  sync: SyncOutcome;
  ini: EnsureIniResult;
  server: EnsureServerResult;
  health: HealthResult;
}

export interface RuntimeOptions {
  workspaceDir: string;
  deps?: Partial<OsDeps>;
}

/**
 * Bootstrap completo: allinea il runtime al commit GenieX, genera l'INI se
 * manca (euristiche del launcher core), avvia llama-server solo se la porta
 * router e' libera e identificata, attende la readiness HTTP (warm-up HTP).
 */
export async function bootstrapRuntime(
  options: RuntimeOptions,
): Promise<BootstrapResult> {
  const deps: OsDeps = { ...nodeDeps, ...options.deps };
  const paths = defaultPaths(options.workspaceDir);
  const sync = await ensureRuntime({
    paths: {
      geniexExe: paths.geniexExe,
      llamaServerExe: paths.serverExe,
      runtimeDir: paths.binPath,
    },
    workspaceDir: paths.workspaceDir,
    binPath: paths.binPath,
    geniexDir: paths.geniexDir,
    deps,
  });
  const ini = await ensureModelsIni({
    iniPath: paths.iniPath,
    workspaceDir: paths.workspaceDir,
    exec: deps.exec,
    exists: deps.exists,
    writeFile: deps.writeFile,
  });
  const server = await ensureServer({
    fetch: deps.fetch,
    spawn: deps.spawn,
    runtimeDir: paths.binPath,
    serverExe: paths.serverExe,
    iniPath: paths.iniPath,
    modelsDir: paths.modelsDir,
  });
  const health = await waitForHealth({ fetch: deps.fetch, sleep: deps.sleep, now: deps.now });
  return { sync, ini, server, health };
}

export interface HookOptions extends RuntimeOptions {
  /** Override iniettabile del bootstrap (test del hook session.created). */
  bootstrap?: () => Promise<unknown>;
  /** Intervallo del watchdog (default 15 s). */
  watchdogIntervalMs?: number;
  /** Factory iniettabile del watchdog (test del wiring). */
  startWatchdogFn?: (options: WatchdogOptions) => WatchdogHandle;
  /** Disabilita il watcher automatico dei modelli (utile nei test unitari). */
  disableModelWatcher?: boolean;
  /** Factory iniettabile del model watcher (test del wiring). */
  startModelWatcherFn?: (options: ModelWatcherOptions) => ModelWatcher;
}

export function createHexagonHooks(options: HookOptions): Hooks {
  const workspaceDir = options.workspaceDir || process.cwd();
  const deps: OsDeps = { ...nodeDeps, ...options.deps };
  const paths = defaultPaths(workspaceDir);
  const bootstrap =
    options.bootstrap ?? (() => bootstrapRuntime({ ...options, workspaceDir }));
  const startWatchdogFn = options.startWatchdogFn ?? startWatchdog;
  const startModelWatcherFn = options.startModelWatcherFn ?? startModelWatcher;

  let sessions = 0;
  let watchdog: WatchdogHandle | null = null;
  let modelWatcher: ModelWatcher | null = null;

  const recover = async (): Promise<void> => {
    await ensureServer({
      fetch: deps.fetch,
      spawn: deps.spawn,
      runtimeDir: paths.binPath,
      serverExe: paths.serverExe,
      iniPath: paths.iniPath,
      modelsDir: paths.modelsDir,
    });
    await waitForHealth({ fetch: deps.fetch, sleep: deps.sleep, now: deps.now });
  };

  const ensureWatchdog = (): void => {
    if (watchdog) return;
    watchdog = startWatchdogFn({
      probe: () => probeHealth({ fetch: deps.fetch }),
      recover,
      intervalMs: options.watchdogIntervalMs,
      onError: (error: unknown) => {
        console.error("[hexagon-runtime] watchdog: recupero fallito:", error);
      },
    });
  };

  const stopWatchdog = (): void => {
    watchdog?.stop();
    watchdog = null;
  };

  const ensureModelWatcher = (): void => {
    if (modelWatcher || options.disableModelWatcher) return;
    modelWatcher = startModelWatcherFn({
      modelsDir: paths.modelsDir,
      workspaceDir: paths.workspaceDir,
      listDir: deps.listDir,
      exists: deps.exists,
      exec: deps.exec,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      onQualified: (modelId, success) => {
        if (success) {
          console.log(`[hexagon-runtime] Modello ${modelId} qualificato con successo.`);
        }
      },
    });
    void modelWatcher.checkNow();
  };

  const stopModelWatcher = (): void => {
    modelWatcher?.stop();
    modelWatcher = null;
  };

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type === "session.created") {
      sessions += 1;
      // Fire-and-forget: il warm-up NPU (fino a 30 s) non deve bloccare la sessione.
      void bootstrap()
        .then(() => {
          ensureWatchdog();
          ensureModelWatcher();
        })
        .catch((error: unknown) => {
          console.error("[hexagon-runtime] bootstrap runtime fallito:", error);
        });
    } else if (event.type === "session.deleted") {
      sessions = Math.max(0, sessions - 1);
      if (sessions === 0) {
        stopWatchdog();
        stopModelWatcher();
      }
    } else if (event.type === "server.instance.disposed") {
      sessions = 0;
      stopWatchdog();
      stopModelWatcher();
    }
  };

  const config: NonNullable<Hooks["config"]> = async (input) => {
    let ini: ModelsIni | undefined;
    if (await deps.exists(paths.iniPath)) {
      const text = await deps.readFile(paths.iniPath).catch(() => "");
      ini = parseModelsIni(text);
    }
    const provider = buildHexagonProvider(ini);
    const existing = input.provider?.[LOCAL_PROVIDER_ID];
    // Il plugin e' l'autorita' hardware: sui modelli noti i contesti testati
    // prevalgono; le opzioni utente (baseURL/apiKey) e i modelli ignoti al
    // plugin restano preservati.
    input.provider = {
      ...input.provider,
      [LOCAL_PROVIDER_ID]: {
        ...existing,
        name: existing?.name ?? provider.name,
        npm: provider.npm,
        options: existing?.options ?? provider.options,
        models: { ...existing?.models, ...provider.models },
      },
    };
    if (!input.model) input.model = `${LOCAL_PROVIDER_ID}/Ornith-1.5-9B-Q4_0`;
    if (!input.small_model) input.small_model = `${LOCAL_PROVIDER_ID}/MiniCPM5-2B-Q4_K_M`;
  };

  const chatParams: NonNullable<Hooks["chat.params"]> = async (input, output) => {
    if (isLocalModel(input.model.providerID)) {
      // Tool-calling deterministico sui modelli locali: niente reasoning libero.
      output.options.reasoning_effort = "none";
    }
  };

  return {
    event,
    config,
    "chat.params": chatParams,
    tool: createHexagonTools({
      fetch: deps.fetch,
      exec: deps.exec,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      listDir: deps.listDir,
      exists: deps.exists,
      modelsDir: paths.modelsDir,
      workspaceDir: paths.workspaceDir,
      sync: ({ force } = {}) =>
        ensureRuntime({
          paths: {
            geniexExe: paths.geniexExe,
            llamaServerExe: paths.serverExe,
            runtimeDir: paths.binPath,
          },
          workspaceDir: paths.workspaceDir,
          binPath: paths.binPath,
          geniexDir: paths.geniexDir,
          force,
          deps,
        }),
    }),
  };
}

/** Ingresso del plugin per il loader Kilo. */
export const pluginInit: Plugin = async (input) => {
  const workspaceDir =
    (input && (input.worktree || input.directory)) || process.cwd();
  return createHexagonHooks({ workspaceDir });
};

/** Descrittore stabile richiesto dal piano di pivot (introspection/test). */
export const plugin = { id: "hexagon-runtime", server: pluginInit } as const;

export default pluginInit;

