/**
 * qualify.ts — Qualification Gate hardware e persistenza del registro modelli.
 *
 * Esegue il benchmark empirico (llama-bench / benchmark-hexagon.ps1) per validare
 * l'offload reale su NPU/GPU e promuovere i modelli da UNTESTED a CERTIFIED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DiscoveredModel } from "./discovery.js";
import { BUNDLED_BENCH_SCRIPT } from "./process.js";
import { runBenchmark, type BenchReport } from "./tools.js";
import type { ExecFn, ExistsFn, MkdirFn, ReadFileFn, WriteFileFn } from "./types.js";

export interface BenchmarkMetrics {
  prefillTokPerSec: number;
  genTokPerSec: number;
  device: string;
  npuWatts?: number;
  gpuWatts?: number;
  socWatts?: number;
}

export interface QualificationProfile {
  modelId: string;
  status: "certified" | "incompatible";
  device: string;
  tensorSplit?: string;
  contextWindow: number;
  metrics?: BenchmarkMetrics;
  error?: string;
  timestamp: string;
}

export type ModelsRegistry = Record<string, QualificationProfile>;

export function defaultRegistryPath(localAppData = process.env.LOCALAPPDATA): string {
  const base = localAppData || join(homedir(), "AppData", "Local");
  return join(base, "Hexagon", "models-registry.json");
}

export interface RegistryIoDeps {
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  exists?: ExistsFn;
  mkdir?: MkdirFn;
}

export async function loadRegistry(
  registryPath = defaultRegistryPath(),
  deps: RegistryIoDeps = {},
): Promise<ModelsRegistry> {
  const read = deps.readFile ?? (async (p) => readFileSync(p, "utf-8"));
  try {
    const raw = await read(registryPath);
    return JSON.parse(raw) as ModelsRegistry;
  } catch {
    return {};
  }
}

export async function saveRegistry(
  registry: ModelsRegistry,
  registryPath = defaultRegistryPath(),
  deps: RegistryIoDeps = {},
): Promise<void> {
  const write = deps.writeFile ?? (async (p, c) => writeFileSync(p, c, "utf-8"));
  const exists = deps.exists ?? (async (p) => existsSync(p));
  const mkdir: MkdirFn =
    deps.mkdir ??
    (deps.writeFile
      ? async () => {}
      : (p) => {
          mkdirSync(p, { recursive: true });
        });
  const dir = dirname(registryPath);
  if (!(await exists(dir))) {
    await mkdir(dir);
  }
  const content = JSON.stringify(registry, null, 2);
  await write(registryPath, content);
}

export interface QualifyOptions {
  model: DiscoveredModel;
  workspaceDir: string;
  exec: ExecFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  exists?: ExistsFn;
  mkdir?: MkdirFn;
  registryPath?: string;
  benchScript?: string;
}

/**
 * Esegue il Qualification Gate hardware per un modello:
 * 1. Lancia il benchmark con parametri ottimali.
 * 2. Se ha successo, promuove a CERTIFIED e registra le metriche.
 * 3. Se fallisce, marca come INCOMPATIBLE con l'errore descrittivo.
 */
export async function qualifyModel(options: QualifyOptions): Promise<QualificationProfile> {
  const { model, workspaceDir, exec, readFile } = options;
  const timestamp = new Date().toISOString();

  try {
    const report: BenchReport = await runBenchmark({
      exec,
      readFile,
      workspaceDir,
      model: model.id,
      benchScript: options.benchScript ?? BUNDLED_BENCH_SCRIPT,
      repetitions: 1,
    });

    const rows = report.results;
    const ppRow = rows.find((r) => r.test.includes("pp")) ?? rows[0];
    const tgRow = rows.find((r) => r.test.includes("tg")) ?? rows[rows.length - 1];

    const metrics: BenchmarkMetrics = {
      prefillTokPerSec: ppRow ? ppRow.tokPerSec : 0,
      genTokPerSec: tgRow ? tgRow.tokPerSec : 0,
      device: model.device,
      npuWatts: ppRow?.npuW ?? undefined,
      gpuWatts: ppRow?.gpuW ?? undefined,
      socWatts: ppRow?.socW ?? undefined,
    };

    const profile: QualificationProfile = {
      modelId: model.id,
      status: "certified",
      device: model.device,
      tensorSplit: model.tensorSplit,
      contextWindow: model.contextWindow,
      metrics,
      timestamp,
    };

    // Aggiorna registro locale
    const regPath = options.registryPath ?? defaultRegistryPath();
    const registry = await loadRegistry(regPath, { readFile: options.readFile });
    registry[model.id] = profile;
    await saveRegistry(registry, regPath, {
      writeFile: options.writeFile,
      exists: options.exists,
      mkdir: options.mkdir,
    });

    return profile;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const profile: QualificationProfile = {
      modelId: model.id,
      status: "incompatible",
      device: model.device,
      contextWindow: 16_384,
      error: errMsg,
      timestamp,
    };

    // Registra comunque l'errore per evitare retry infiniti
    const regPath = options.registryPath ?? defaultRegistryPath();
    const registry = await loadRegistry(regPath, { readFile: options.readFile });
    registry[model.id] = profile;
    await saveRegistry(registry, regPath, {
      writeFile: options.writeFile,
      exists: options.exists,
      mkdir: options.mkdir,
    });

    return profile;
  }
}
