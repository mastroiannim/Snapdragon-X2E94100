/**
 * tools.ts — Agent tool per Kilo: hexagon_status, hexagon_sync, hexagon_bench.
 *
 * La logica di report e' separata dai wrapper zod cosi' i test verificano
 * formattazione JSON e parsing senza il runtime Kilo.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@kilocode/plugin";
import { installProviderConfig } from "./config.js";
import {
  scanModels,
  syncDiscoveredModelsToIni,
  type SyncModelsResult,
} from "./discovery.js";
import { nodeExists, nodeListDir, nodeNow, nodeSpawn } from "./os.js";
import {
  BUNDLED_BENCH_SCRIPT,
  defaultPaths,
  reloadServerIfStale,
  restartServer,
  ROUTER_HOST,
  ROUTER_PORT,
} from "./process.js";
import { waitForHealth, type HealthResult } from "./health.js";
import { qualifyModel } from "./qualify.js";
import type { RuntimeCheck, SyncOutcome } from "./sync.js";
import type {
  ExecFn,
  ExistsFn,
  FetchFn,
  ListDirFn,
  NowFn,
  ReadFileFn,
  SleepFn,
  SpawnFn,
  WriteFileFn,
} from "./types.js";

export interface StatusReport {
  router: { host: string; port: number; active: boolean; ready: boolean };
  latencyMs: number | null;
  loadedModels: string[];
  runtime?: RuntimeCheck | { error: string };
  error?: string;
}

export interface StatusOptions {
  fetch: FetchFn;
  port?: number;
  host?: string;
  now?: NowFn;
}

/** Stato router: latenza /health e modelli caricati via /v1/models. */
export async function collectStatus(options: StatusOptions): Promise<StatusReport> {
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  const now = options.now ?? nodeNow;
  const base = `http://${host}:${port}`;
  const start = now();
  try {
    const health = await options.fetch(`${base}/health`);
    const latencyMs = now() - start;
    let loadedModels: string[] = [];
    try {
      const models = await options.fetch(`${base}/v1/models`);
      if (models.ok) {
        const body = (await models.json()) as { data?: Array<{ id?: string }> };
        loadedModels = (body.data ?? [])
          .map((entry) => entry.id ?? "")
          .filter((id) => id.length > 0);
      }
    } catch {
      /* elenco modelli non disponibile: lo stato router resta valido */
    }
    return {
      router: { host, port, active: true, ready: health.status === 200 },
      latencyMs,
      loadedModels,
    };
  } catch (error) {
    return {
      router: { host, port, active: false, ready: false },
      latencyMs: null,
      loadedModels: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface BenchRow {
  model: string;
  profile: string;
  test: string;
  tokPerSec: number;
  stdDev: number | null;
  npuW: number | null;
  gpuW: number | null;
  cpuW: number | null;
  memW: number | null;
  infraW: number | null;
  socW: number | null;
  sysW: number | null;
}

const POWER_FIELDS = [
  "npuW",
  "gpuW",
  "cpuW",
  "memW",
  "infraW",
  "socW",
  "sysW",
] as const;

/** Cella numerica opzionale: "N/D", vuoto o non numerico -> null; virgola it-IT normalizzata. */
export function parseOptionalNumber(cell: string | undefined): number | null {
  if (cell === undefined) return null;
  const clean = cell.replace(/\*\*/g, "").trim();
  if (!clean || clean === "N/D") return null;
  const value = Number.parseFloat(clean.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Parsing del report markdown di benchmark-hexagon.ps1, incluse le colonne
 * PMIC (NPU/GPU/CPU/RAM/INFRA/SoC/Sistema in W) e la deviazione standard:
 * | ``modello`` | **profilo** | ``test`` | **tok/s** ± stddev | npu | gpu | cpu | mem | infra | **soc** | **sys** |
 * Le colonne mancanti (report legacy) restano null: i valori non misurati
 * sono espliciti, mai zero.
 */
export function parseBenchReport(markdown: string): BenchRow[] {
  const rows: BenchRow[] = [];
  const pattern =
    /^\|\s*`{1,2}([^`|]+)`{1,2}\s*\|\s*\*\*([^*|]+)\*\*\s*\|\s*`{1,2}([^`|]+)`{1,2}\s*\|\s*\*\*([0-9]+(?:[.,][0-9]+)?)\*\*\s*(?:±\s*([0-9]+(?:[.,][0-9]+)?))?\s*\|?(.*)$/;
  for (const line of markdown.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    const cells = (match[6] ?? "").split("|");
    const row: BenchRow = {
      model: match[1].trim(),
      profile: match[2].trim(),
      test: match[3].trim(),
      tokPerSec: Number.parseFloat(match[4].replace(",", ".")),
      stdDev: parseOptionalNumber(match[5]),
      npuW: null,
      gpuW: null,
      cpuW: null,
      memW: null,
      infraW: null,
      socW: null,
      sysW: null,
    };
    POWER_FIELDS.forEach((field, index) => {
      row[field] = parseOptionalNumber(cells[index]);
    });
    rows.push(row);
  }
  return rows;
}

export interface BenchReport {
  model: string;
  results: BenchRow[];
  reportPath: string;
}

export interface BenchmarkOptions {
  exec: ExecFn;
  readFile: ReadFileFn;
  workspaceDir: string;
  model?: string;
  repetitions?: number;
  reportPath?: string;
  benchScript?: string;
}

/** Risolve lo script di benchmark: workspaceDir se presente, altrimenti asset bundled. */
export function resolveBenchScript(options: {
  workspaceDir?: string;
  exists?: (path: string) => boolean;
} = {}): string {
  const exists = options.exists ?? existsSync;
  if (options.workspaceDir) {
    const wsScript = join(options.workspaceDir, "benchmark-hexagon.ps1");
    if (exists(wsScript)) return wsScript;
  }
  return BUNDLED_BENCH_SCRIPT;
}

let benchmarkInProgress = false;

/** Verifica se un benchmark e' attualmente in corso. */
export function isBenchmarkActive(): boolean {
  return benchmarkInProgress;
}

/** Reset del lock benchmark (riservato ai test). */
export function resetBenchmarkActiveForTests(): void {
  benchmarkInProgress = false;
}

/** Lancia benchmark-hexagon.ps1 e legge i token/s dal report generato. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchReport> {
  if (benchmarkInProgress) {
    throw new Error(
      "Benchmark già in esecuzione: l'avvio di benchmark in parallelo è bloccato per prevenire la saturazione della memoria (RAM/VRAM).",
    );
  }
  benchmarkInProgress = true;
  try {
    const script =
      options.benchScript ??
      resolveBenchScript({ workspaceDir: options.workspaceDir });
    const reportPath =
      options.reportPath ?? join(tmpdir(), `hexagon-bench-${Date.now()}.md`);
    const args = [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Repetitions",
      String(options.repetitions ?? 1),
      "-ReportPath",
      reportPath,
    ];
    if (options.model) {
      args.push("-Models", options.model.endsWith(".gguf") ? options.model : `${options.model}.gguf`);
    }
    const result = await options.exec("powershell", args, {
      cwd: options.workspaceDir,
      timeoutMs: 1_800_000,
    });
    if (result.code !== 0) {
      throw new Error(
        `benchmark-hexagon.ps1 fallito (exit ${result.code}): ` +
          (result.stderr.trim() || result.stdout.trim() || "output vuoto"),
      );
    }
    const markdown = await options.readFile(reportPath);
    return {
      model: options.model ?? "suite predefinita",
      results: parseBenchReport(markdown),
      reportPath,
    };
  } finally {
    benchmarkInProgress = false;
  }
}

export interface HexagonToolDeps {
  fetch: FetchFn;
  exec: ExecFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  listDir?: ListDirFn;
  exists?: ExistsFn;
  spawn?: SpawnFn;
  sleep?: SleepFn;
  modelsDir?: string;
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
        "su 127.0.0.1:18803, latenza /health, modelli caricati e allineamento binario " +
        "GenieX (commit e SHA-256 DLL). Se runtime.needsSync e' true, chiama direttamente " +
        "hexagon_sync senza eseguire comandi shell manuali.",
      args: {},
      async execute() {
        const status = await collectStatus({ fetch: deps.fetch });
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
        "al commit/DLL GenieX (stop eventuale server attivo, swap con backup, riavvio automatico) " +
        "e sincronizza i modelli GGUF nel router locale verificando /health al termine.",
      args: {},
      async execute() {
        const syncRes = await deps.sync({ force: true });
        const paths = defaultPaths(deps.workspaceDir);
        let catalogRes: SyncModelsResult = {
          addedModels: [],
          removedModels: [],
          totalModels: 0,
          iniUpdated: false,
        };
        let routerReloaded = false;
        if (deps.writeFile && deps.listDir && deps.exists) {
          catalogRes = await syncDiscoveredModelsToIni({
            modelsDir: deps.modelsDir ?? paths.modelsDir,
            iniPath: paths.iniPath,
            workspaceDir: deps.workspaceDir,
            deps: {
              listDir: deps.listDir,
              exists: deps.exists,
              readFile: deps.readFile,
              writeFile: deps.writeFile,
              exec: deps.exec,
            },
          }).catch(() => ({
            addedModels: [],
            removedModels: [],
            totalModels: 0,
            iniUpdated: false,
          }));

          if (deps.spawn) {
            const reload = await reloadServerIfStale({
              fetch: deps.fetch,
              spawn: deps.spawn,
              exec: deps.exec,
              readFile: deps.readFile,
              sleep: deps.sleep,
              runtimeDir: paths.binPath,
              serverExe: paths.serverExe,
              iniPath: paths.iniPath,
              modelsDir: deps.modelsDir ?? paths.modelsDir,
            }).catch(() => ({ reloaded: false }));
            routerReloaded = reload.reloaded;
          }
        }
        let health: HealthResult | undefined;
        if (syncRes.updated || routerReloaded) {
          health = await waitForHealth({
            fetch: deps.fetch,
            sleep: deps.sleep,
          }).catch(() => undefined);
        }
        return JSON.stringify(
          {
            ...syncRes,
            ...(health ? { health } : {}),
            catalog: {
              ...catalogRes,
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
          runtimeDir: paths.binPath,
          serverExe: paths.serverExe,
          iniPath: paths.iniPath,
          modelsDir: deps.modelsDir ?? paths.modelsDir,
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
      },
      async execute(args) {
        const report = await runBenchmark({
          exec: deps.exec,
          readFile: deps.readFile,
          workspaceDir: deps.workspaceDir,
          model: args.model,
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
          iniPath: paths.iniPath,
          readFile: deps.readFile,
        });
        return JSON.stringify(res, null, 2);
      },
    }),
    hexagon_models: tool({
      description:
        "Elenca tutti i modelli GGUF presenti nella cache locale, stato di certificazione " +
        "(certified vs untested), dimensione e allocazione hardware (HTP0/GPU).",
      args: {},
      async execute() {
        const modelsDir = deps.modelsDir ?? defaultPaths(deps.workspaceDir).modelsDir;
        const listDir = deps.listDir ?? nodeListDir;
        const exists = deps.exists ?? nodeExists;
        const models = await scanModels({
          modelsDir,
          deps: { listDir, exists, exec: deps.exec },
        });
        return JSON.stringify(models, null, 2);
      },
    }),
    hexagon_qualify: tool({
      description:
        "Esegue il Qualification Gate hardware (benchmark e calibrazione) su un modello locale per promuoverlo a CERTIFIED.",
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
          deps: { listDir, exists, exec: deps.exec },
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
        });
        return JSON.stringify(profile, null, 2);
      },
    }),
  };
}
