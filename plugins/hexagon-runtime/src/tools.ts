/**
 * tools.ts — Agent tool per Kilo: hexagon_status, hexagon_sync, hexagon_bench.
 *
 * La logica di report e' separata dai wrapper zod cosi' i test verificano
 * formattazione JSON e parsing senza il runtime Kilo.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@kilocode/plugin";
import { nodeNow } from "./os.js";
import { ROUTER_HOST, ROUTER_PORT } from "./process.js";
import type { SyncOutcome } from "./sync.js";
import type { ExecFn, FetchFn, NowFn, ReadFileFn } from "./types.js";

export interface StatusReport {
  router: { host: string; port: number; active: boolean; ready: boolean };
  latencyMs: number | null;
  loadedModels: string[];
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
}

/**
 * Parsing del report markdown di benchmark-hexagon.ps1:
 * | ``modello`` | **profilo** | ``test`` | **tok/s** ± stddev | ...
 * La virgola decimale (culture it-IT) viene normalizzata.
 */
export function parseBenchReport(markdown: string): BenchRow[] {
  const rows: BenchRow[] = [];
  const pattern =
    /^\|\s*`{1,2}([^`|]+)`{1,2}\s*\|\s*\*\*([^*|]+)\*\*\s*\|\s*`{1,2}([^`|]+)`{1,2}\s*\|\s*\*\*([0-9]+(?:[.,][0-9]+)?)\*\*/;
  for (const line of markdown.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (!match) continue;
    rows.push({
      model: match[1].trim(),
      profile: match[2].trim(),
      test: match[3].trim(),
      tokPerSec: Number.parseFloat(match[4].replace(",", ".")),
    });
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
}

/** Lancia benchmark-hexagon.ps1 e legge i token/s dal report generato. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchReport> {
  const script = join(options.workspaceDir, "benchmark-hexagon.ps1");
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
}

export interface HexagonToolDeps {
  fetch: FetchFn;
  exec: ExecFn;
  readFile: ReadFileFn;
  workspaceDir: string;
  sync: (options: { force?: boolean }) => Promise<SyncOutcome>;
}

/** Definizioni tool Kilo (zod) con output JSON stabile. */
export function createHexagonTools(deps: HexagonToolDeps) {
  return {
    hexagon_status: tool({
      description:
        "Stato del runtime Hexagon locale (Snapdragon X2 Elite): router llama-server " +
        "su 127.0.0.1:18803, latenza /health e modelli caricati.",
      args: {},
      async execute() {
        return JSON.stringify(await collectStatus({ fetch: deps.fetch }), null, 2);
      },
    }),
    hexagon_sync: tool({
      description:
        "Forza il riallineamento del runtime llama.cpp ARM64 al commit GenieX " +
        "eseguendo sync-geniex.ps1 -Apply -NoStopServer.",
      args: {},
      async execute() {
        return JSON.stringify(await deps.sync({ force: true }), null, 2);
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
  };
}
