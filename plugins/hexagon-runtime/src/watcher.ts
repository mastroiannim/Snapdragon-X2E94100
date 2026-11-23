/**
 * watcher.ts — Monitoraggio in background della cache modelli per qualificazione automatica.
 *
 * Scansiona la directory modelli (.cache/geniex/models) e, non appena rileva un nuovo file
 * GGUF non testato, avvia la qualificazione empirica in background senza bloccare la sessione.
 */
import { scanModels, type DiscoveredModel } from "./discovery.js";
import { loadRegistry, qualifyModel, type ModelsRegistry } from "./qualify.js";
import type { ExecFn, ExistsFn, ListDirFn, ReadFileFn, WriteFileFn } from "./types.js";

export interface ModelWatcherDeps {
  modelsDir: string;
  workspaceDir: string;
  listDir: ListDirFn;
  exists: ExistsFn;
  exec: ExecFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  onQualified?: (modelId: string, success: boolean) => void;
  onError?: (error: unknown) => void;
}

export interface ModelWatcherOptions extends ModelWatcherDeps {
  intervalMs?: number;
  registryPath?: string;
  /** Consenso esplicito dell'utente per eseguire benchmark empirici automatici in background. Default: false. */
  enableAutoBenchmark?: boolean;
}

export interface ModelWatcher {
  checkNow: () => Promise<DiscoveredModel[]>;
  stop: () => void;
}

export const WATCHER_DEFAULT_INTERVAL_MS = 60_000;

/**
 * Avvia il watcher periodico in background.
 */
export function startModelWatcher(options: ModelWatcherOptions): ModelWatcher {
  const interval = options.intervalMs ?? WATCHER_DEFAULT_INTERVAL_MS;
  let running = false;
  let stopped = false;

  const checkNow = async (): Promise<DiscoveredModel[]> => {
    if (running || stopped) return [];
    running = true;
    try {
      const registry: ModelsRegistry = await loadRegistry(options.registryPath, {
        readFile: options.readFile,
      });
      const certifiedIds = new Set(
        Object.entries(registry)
          .filter(([_, prof]) => prof.status === "certified")
          .map(([id]) => id),
      );

      const discovered = await scanModels({
        modelsDir: options.modelsDir,
        deps: {
          listDir: options.listDir,
          exists: options.exists,
          exec: options.exec,
        },
        certifiedIds,
      });

      const untested = discovered.filter((m) => m.status === "untested");
      if (options.enableAutoBenchmark) {
        for (const model of untested) {
          if (stopped) break;
          // Qualifica in background SOLO SE c'e' espresso consenso dell'utente
          const res = await qualifyModel({
            model,
            workspaceDir: options.workspaceDir,
            exec: options.exec,
            readFile: options.readFile,
            writeFile: options.writeFile,
            registryPath: options.registryPath,
          });
          if (options.onQualified) {
            options.onQualified(model.id, res.status === "certified");
          }
        }
      } else if (untested.length > 0) {
        console.warn(
          `[hexagon-runtime] Rilevati ${untested.length} modelli non testati. Benchmark automatico ignorato (richiede consenso esplicito per evitare saturazione memoria).`,
        );
      }

      return discovered;
    } catch (error) {
      if (options.onError) options.onError(error);
      return [];
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void checkNow();
  }, interval);

  return {
    checkNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
