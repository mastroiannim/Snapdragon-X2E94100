/**
 * benchmark.ts — Esecuzione e parsing report di benchmark-hexagon.ps1.
 *
 * Isolato da tools.ts per non trascinare la devDependency @kilocode/plugin
 * nei moduli runtime/CLI standalone (cli.js, discovery.ts, qualify.ts).
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_BENCH_SCRIPT } from "./process.js";
import { parseLlamaLogs, type RealOffloadTelemetry } from "./telemetry.js";
import type { ExecFn, ReadFileFn } from "./types.js";

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
  offload?: RealOffloadTelemetry;
  warmUpMs?: number | null;
  loadTimeMs?: number | null;
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
  telemetryPath?: string;
  offload?: RealOffloadTelemetry;
  warmUpMs?: number | null;
  loadTimeMs?: number | null;
}

export interface BenchmarkOptions {
  exec: ExecFn;
  readFile: ReadFileFn;
  workspaceDir: string;
  model?: string;
  device?: string;
  tensorSplit?: string;
  repetitions?: number;
  reportPath?: string;
  benchScript?: string;
  exists?: (path: string) => boolean;
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
      resolveBenchScript({ workspaceDir: options.workspaceDir, exists: options.exists });
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
    if (options.device) {
      args.push("-Device", options.device);
    }
    if (options.tensorSplit) {
      args.push("-TensorSplit", options.tensorSplit);
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
    const results = parseBenchReport(markdown);
    const telemetryPath = `${reportPath}.telemetry.json`;
    let hasTelemetrySidecar = false;
    let reportOffload: RealOffloadTelemetry | undefined;
    let reportWarmUpMs: number | null | undefined;
    let reportLoadTimeMs: number | null | undefined;

    try {
      const sidecarRaw = await options.readFile(telemetryPath);
      if (sidecarRaw.trim()) {
        const parsedSidecar = JSON.parse(sidecarRaw) as {
          results?: Array<{
            model?: string;
            profile?: string;
            test?: string;
            warmUpMs?: number | null;
            loadTimeMs?: number | null;
            offload?: RealOffloadTelemetry | null;
          }>;
        };
        if (Array.isArray(parsedSidecar?.results)) {
          hasTelemetrySidecar = true;
          for (const row of results) {
            const match = parsedSidecar.results.find(
              (entry) =>
                entry.test === row.test &&
                (!entry.profile || entry.profile === row.profile) &&
                (!entry.model || entry.model === row.model),
            );
            if (!match) continue;
            if (match.offload) {
              row.offload = match.offload;
              if (!reportOffload) reportOffload = match.offload;
            }
            if (match.warmUpMs !== undefined) {
              row.warmUpMs = match.warmUpMs;
              if (reportWarmUpMs === undefined || reportWarmUpMs === null) {
                reportWarmUpMs = match.warmUpMs;
              }
            }
            if (match.loadTimeMs !== undefined) {
              row.loadTimeMs = match.loadTimeMs;
              if (reportLoadTimeMs === undefined || reportLoadTimeMs === null) {
                reportLoadTimeMs = match.loadTimeMs;
              }
            }
          }
          if (!reportOffload) {
            const firstWithOffload = parsedSidecar.results.find((r) => Boolean(r.offload));
            if (firstWithOffload?.offload) reportOffload = firstWithOffload.offload;
          }
          if (reportWarmUpMs === undefined || reportWarmUpMs === null) {
            const firstWarm = parsedSidecar.results.find((r) => typeof r.warmUpMs === "number");
            if (firstWarm) reportWarmUpMs = firstWarm.warmUpMs ?? null;
          }
          if (reportLoadTimeMs === undefined || reportLoadTimeMs === null) {
            const firstLoad = parsedSidecar.results.find((r) => typeof r.loadTimeMs === "number");
            if (firstLoad) reportLoadTimeMs = firstLoad.loadTimeMs ?? null;
          }
        }
      }
    } catch {
      /* sidecar telemetria opzionale: assenza o file non valido ignorati */
    }

    if (!reportOffload && (result.stderr.trim() || result.stdout.trim())) {
      const fromOutput = parseLlamaLogs(`${result.stderr}\n${result.stdout}`, "llama-bench");
      if (fromOutput.offload) {
        reportOffload = fromOutput.offload;
      }
      if (reportLoadTimeMs === undefined && fromOutput.warmUp.loadTimeMs !== null) {
        reportLoadTimeMs = fromOutput.warmUp.loadTimeMs;
      }
      if (reportWarmUpMs === undefined && fromOutput.warmUp.htpWarmUpMs !== null) {
        reportWarmUpMs = fromOutput.warmUp.htpWarmUpMs;
      }
    }

    return {
      model: options.model ?? "suite predefinita",
      results,
      reportPath,
      ...(hasTelemetrySidecar ? { telemetryPath } : {}),
      ...(reportOffload ? { offload: reportOffload } : {}),
      ...(reportWarmUpMs !== undefined ? { warmUpMs: reportWarmUpMs } : {}),
      ...(reportLoadTimeMs !== undefined ? { loadTimeMs: reportLoadTimeMs } : {}),
    };
  } finally {
    benchmarkInProgress = false;
  }
}
