/**
 * tools.ts — Agent tool per Kilo: hexagon_status, hexagon_sync, hexagon_bench.
 *
 * La logica di report e' separata dai wrapper zod cosi' i test verificano
 * formattazione JSON e parsing senza il runtime Kilo.
 */
import { tool } from "@kilocode/plugin";
import {
  isBenchmarkActive,
  parseBenchReport,
  parseOptionalNumber,
  resetBenchmarkActiveForTests,
  resolveBenchScript,
  runBenchmark,
  type BenchmarkOptions,
  type BenchReport,
  type BenchRow,
} from "./benchmark.js";
import { runBootstrapCycle } from "./bootstrap.js";
import { installProviderConfig } from "./config.js";
import { scanModels } from "./discovery.js";
import { nodeExists, nodeListDir, nodeNow, nodeSpawn } from "./os.js";
import {
  defaultLogsDir,
  defaultPaths,
  defaultServerLogPath,
  restartServer,
} from "./process.js";
import { collectStatus, type StatusOptions, type StatusReport, type OffloadInfo, type WarmUpInfo } from "./health.js";
import { qualifyModel } from "./qualify.js";
import type { RuntimeCheck, SyncOutcome } from "./sync.js";
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

export {
  collectStatus,
  isBenchmarkActive,
  parseBenchReport,
  parseOptionalNumber,
  resetBenchmarkActiveForTests,
  resolveBenchScript,
  runBenchmark,
  type BenchmarkOptions,
  type BenchReport,
  type BenchRow,
  type OffloadInfo,
  type StatusOptions,
  type StatusReport,
  type WarmUpInfo,
};

export interface HexagonToolDeps {
  fetch: FetchFn;
  exec: ExecFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  listDir?: ListDirFn;
  exists?: ExistsFn;
  mkdir?: MkdirFn;
  spawn?: SpawnFn;
  sleep?: SleepFn;
  now?: NowFn;
  modelsDir?: string;
  iniPath?: string;
  registryPath?: string;
  configDir?: string;
  logPath?: string;
  logsDir?: string;
  workspaceDir: string;
  sync: (options: { force?: boolean; stopServer?: boolean }) => Promise<SyncOutcome>;
  checkRuntime?: () => Promise<RuntimeCheck>;
}

/** Definizioni tool Kilo (zod) con output JSON stabile. */
export function createHexagonTools(deps: HexagonToolDeps) {
  return {
    hexagon_status: tool({
      description:
        "Stato del runtime Hexagon locale (Snapdragon X2 Elite): router llama-server " +
        "su 127.0.0.1:18803, latenza /health, modelli caricati, offload reale per-modello " +
        "(device, tensor-split, layer offloaded), tempi di warm-up HTP separati dal throughput " +
        "e allineamento binario GenieX (commit e SHA-256 DLL). " +
        "Se runtime.needsSync e' true, chiama direttamente " +
        "hexagon_sync senza eseguire comandi shell manuali.",
      args: {},
      async execute() {
        const status = await collectStatus({
          fetch: deps.fetch,
          now: deps.now,
          logPath: deps.logPath ?? defaultServerLogPath(),
          logsDir: deps.logsDir ?? defaultLogsDir(),
          readFile: deps.readFile,
          exists: deps.exists,
          listDir: deps.listDir,
        });
        if (deps.checkRuntime) {
          status.runtime = await deps.checkRuntime().catch((error: unknown) => ({
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        return JSON.stringify(status, null, 2);
      },
    }),
    hexagon_sync: tool({
      description:
        "Esegue in modo deterministico il riallineamento atomico del runtime llama.cpp ARM64 " +
        "al commit/DLL GenieX (stop scoped del solo Router gestito, swap con backup, sync modelli, " +
        "avvio e verifica /health).",
      args: {},
      async execute() {
        const paths = defaultPaths(deps.workspaceDir);
        const iniPath = deps.iniPath ?? paths.iniPath;
        const modelsDir = deps.modelsDir ?? paths.modelsDir;
        const cycle = await runBootstrapCycle({
          workspaceDir: deps.workspaceDir,
          runtimeDir: paths.binPath,
          geniexDir: paths.geniexDir,
          geniexExe: paths.geniexExe,
          serverExe: paths.serverExe,
          modelsDir,
          iniPath,
          registryPath: deps.registryPath,
          configDir: deps.configDir,
          forceSync: true,
          ignoreIniErrors: true,
          ignoreCatalogErrors: true,
          ignoreServerErrors: true,
          syncFn: deps.sync,
          deps: {
            exec: deps.exec,
            fetch: deps.fetch,
            spawn: deps.spawn,
            exists: deps.exists ?? nodeExists,
            readFile: deps.readFile,
            writeFile: deps.writeFile,
            listDir: deps.listDir,
            mkdir: deps.mkdir,
            sleep: deps.sleep,
            now: deps.now,
          },
        });
        const routerReloaded = cycle.server.started || cycle.reload.reloaded;
        return JSON.stringify(
          {
            ...cycle.sync,
            ...(cycle.health ? { health: cycle.health } : {}),
            catalog: {
              ...cycle.catalog,
              routerReloaded,
            },
          },
          null,
          2,
        );
      },
    }),
    hexagon_restart: tool({
      description:
        "Arresta e riavvia in modo deterministico il router llama-server su 127.0.0.1:18803 " +
        "ricaricando hexagon-models.ini e verificando /health al termine.",
      args: {},
      async execute() {
        const paths = defaultPaths(deps.workspaceDir);
        const res = await restartServer({
          fetch: deps.fetch,
          spawn: deps.spawn ?? nodeSpawn,
          exec: deps.exec,
          sleep: deps.sleep,
          now: deps.now,
          runtimeDir: paths.binPath,
          serverExe: paths.serverExe,
          iniPath: deps.iniPath ?? paths.iniPath,
          modelsDir: deps.modelsDir ?? paths.modelsDir,
          logFile: deps.logPath ?? defaultServerLogPath(),
        });
        return JSON.stringify(res, null, 2);
      },
    }),
    hexagon_bench: tool({
      description:
        "Esegue benchmark-hexagon.ps1 su un modello locale e restituisce i token/s " +
        "per profilo HTP0 (NPU) e GPUOpenCL.",
      args: {
        model: tool.schema
          .string()
          .optional()
          .describe("Alias del modello (es. Ornith-1.5-9B-Q4_0) o file .gguf; default: suite predefinita"),
        device: tool.schema
          .string()
          .optional()
          .describe("Profilo device esplicito (es. HTP0 o HTP0,GPUOpenCL)"),
        tensorSplit: tool.schema
          .string()
          .optional()
          .describe("Pesi tensor-split (es. 85,15 o 75,25) se device multipli"),
      },
      async execute(args) {
        const report = await runBenchmark({
          exec: deps.exec,
          readFile: deps.readFile,
          workspaceDir: deps.workspaceDir,
          model: args.model,
          device: args.device,
          tensorSplit: args.tensorSplit,
        });
        return JSON.stringify(report, null, 2);
      },
    }),
    hexagon_setup: tool({
      description:
        "Configura o allinea il provider 'hexagon' nel file kilo.json o nella configurazione globale (~/.config/kilo/kilo.jsonc).",
      args: {
        workspace: tool.schema
          .boolean()
          .optional()
          .describe("Se true scrive kilo.json nel workspace locale; se false o omesso aggiorna la configurazione globale"),
      },
      async execute(args) {
        const paths = defaultPaths(deps.workspaceDir);
        const res = await installProviderConfig({
          workspaceDir: args.workspace ? deps.workspaceDir : undefined,
          configDir: deps.configDir,
          iniPath: deps.iniPath ?? paths.iniPath,
          readFile: deps.readFile,
          writeFile: deps.writeFile,
          exists: deps.exists,
          mkdir: deps.mkdir,
          now: deps.now,
        });
        return JSON.stringify(res, null, 2);
      },
    }),
    hexagon_models: tool({
      description:
        "Elenca tutti i modelli GGUF presenti nella cache locale, stato di certificazione " +
        "(certified, untested o incompatible da models-registry.json), dimensione e allocazione hardware (HTP0/GPU).",
      args: {},
      async execute() {
        const modelsDir = deps.modelsDir ?? defaultPaths(deps.workspaceDir).modelsDir;
        const listDir = deps.listDir ?? nodeListDir;
        const exists = deps.exists ?? nodeExists;
        const models = await scanModels({
          modelsDir,
          registryPath: deps.registryPath,
          deps: { listDir, exists, exec: deps.exec, readFile: deps.readFile },
        });
        return JSON.stringify(models, null, 2);
      },
    }),
    hexagon_qualify: tool({
      description:
        "Esegue il Qualification Gate hardware (benchmark e calibrazione) su un modello locale " +
        "per promuoverlo a CERTIFIED. L'output include offload reale (device, layer offloaded/totali, " +
        "tensor-split), tempi di warm-up HTP separati dal throughput steady-state, e metriche PMIC.",
      args: {
        model: tool.schema
          .string()
          .describe("Alias del modello da qualificare (es. Ornith-1.5-9B-Q4_0 o nome file .gguf)"),
      },
      async execute(args) {
        const modelsDir = deps.modelsDir ?? defaultPaths(deps.workspaceDir).modelsDir;
        const listDir = deps.listDir ?? nodeListDir;
        const exists = deps.exists ?? nodeExists;
        const models = await scanModels({
          modelsDir,
          registryPath: deps.registryPath,
          deps: { listDir, exists, exec: deps.exec, readFile: deps.readFile },
        });
        const target = models.find((m) => m.id === args.model || m.fileName === args.model);
        if (!target) {
          return JSON.stringify({ error: `Modello '${args.model}' non trovato in ${modelsDir}` }, null, 2);
        }
        const profile = await qualifyModel({
          model: target,
          workspaceDir: deps.workspaceDir,
          exec: deps.exec,
          readFile: deps.readFile,
          writeFile: deps.writeFile,
          exists: deps.exists,
          mkdir: deps.mkdir,
          registryPath: deps.registryPath,
        });
        return JSON.stringify(profile, null, 2);
      },
    }),
  };
}
