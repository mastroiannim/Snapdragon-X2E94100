/**
 * qualify.ts — Qualification Gate hardware e persistenza del registro modelli.
 *
 * Esegue il benchmark empirico (llama-bench / benchmark-hexagon.ps1) per validare
 * l'offload reale su NPU/GPU e promuovere i modelli da UNTESTED a CERTIFIED.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { type DiscoveredModel } from "./discovery.js";
import { BUNDLED_BENCH_SCRIPT } from "./process.js";
import { runBenchmark, type BenchReport } from "./benchmark.js";
import type { RealOffloadTelemetry } from "./telemetry.js";
import type { ExecFn, ExistsFn, MkdirFn, ReadFileFn, WriteFileFn } from "./types.js";

export interface BenchmarkMetrics {
  prefillTokPerSec: number;
  genTokPerSec: number;
  device: string;
  tensorSplit?: string;
  layersOffloaded?: number;
  layersTotal?: number;
  offloadPercent?: number;
  warmUpMs?: number;
  htpWarmUpMs?: number;
  loadTimeMs?: number;
  offload?: RealOffloadTelemetry;
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
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as ModelsRegistry;
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
  modelsDir?: string;
  exec: ExecFn;
  readFile: ReadFileFn;
  writeFile?: WriteFileFn;
  exists?: ExistsFn;
  mkdir?: MkdirFn;
  registryPath?: string;
  benchScript?: string;
}

function normalizeDeviceList(value: string): string {
  return value
    .trim()
    .split(/[,/]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}

function parseNumericSplit(value: string): number[] | null {
  const clean = value.trim();
  if (!/^\d+(?:\.\d+)?(?:\s*[,/]\s*\d+(?:\.\d+)?)+$/.test(clean)) {
    return null;
  }
  return clean.split(/[,/]/).map((part) => Number.parseFloat(part.trim()));
}

/**
 * Verifica che la colonna profilo del report markdown corrisponda esattamente
 * al device e all'eventuale tensor-split configurati sul modello.
 */
export function matchesConfiguredProfile(
  profileLabel: string,
  device: string,
  tensorSplit?: string,
): boolean {
  const trimmed = profileLabel.trim();
  const parenMatch = /^([^(]+?)(?:\s*\(([^)]+)\))?$/.exec(trimmed);
  if (!parenMatch) return false;

  const rowDevice = normalizeDeviceList(parenMatch[1]);
  const expectedDevice = normalizeDeviceList(device);
  if (!rowDevice || !expectedDevice || rowDevice !== expectedDevice) {
    return false;
  }

  const rowSplit = parenMatch[2] ? parseNumericSplit(parenMatch[2]) : null;
  const expectedSplit = tensorSplit ? parseNumericSplit(tensorSplit) : null;

  if (expectedSplit !== null) {
    if (rowSplit === null || rowSplit.length !== expectedSplit.length) {
      return false;
    }
    return expectedSplit.every((val, idx) => Math.abs(val - rowSplit[idx]) < 1e-4);
  }

  return rowSplit === null;
}

/**
 * Esegue il Qualification Gate hardware per un modello:
 * 1. Lancia il benchmark esclusivamente con il profilo configurato (-Device / -TensorSplit).
 * 2. Estrae unicamente le righe corrispondenti a quel profilo; se assenti, marca INCOMPATIBLE.
 * 3. Persiste il risultato nel registro locale (models-registry.json).
 */
export async function qualifyModel(options: QualifyOptions): Promise<QualificationProfile> {
  const { model, workspaceDir, exec, readFile } = options;
  const timestamp = new Date().toISOString();

  try {
    let modelArg = model.fileName || model.id;
    if (options.modelsDir && model.filePath) {
      const rel = relative(options.modelsDir, model.filePath);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        modelArg = rel;
      }
    }

    const report: BenchReport = await runBenchmark({
      exec,
      readFile,
      workspaceDir,
      model: modelArg,
      device: model.device,
      tensorSplit: model.tensorSplit,
      benchScript: options.benchScript ?? BUNDLED_BENCH_SCRIPT,
      repetitions: 1,
    });

    const allRows = report.results;
    const modelMatches = allRows.filter(
      (r) =>
        r.model === model.fileName ||
        r.model === model.id ||
        r.model === `${model.id}.gguf` ||
        r.model === modelArg ||
        basename(r.model) === model.fileName,
    );
    const candidateRows = modelMatches.length > 0 ? modelMatches : allRows;
    const matchingRows = candidateRows.filter((r) =>
      matchesConfiguredProfile(r.profile, model.device, model.tensorSplit),
    );

    const ppRow = matchingRows.find((r) => /^pp/i.test(r.test));
    const tgRow = matchingRows.find((r) => /^tg/i.test(r.test));

    if (matchingRows.length === 0 || (!ppRow && !tgRow)) {
      const splitLabel = model.tensorSplit ? ` (${model.tensorSplit})` : "";
      throw new Error(
        `Nessuna metrica benchmark trovata per il profilo configurato ${model.device}${splitLabel}`,
      );
    }

    const offload = tgRow?.offload ?? ppRow?.offload ?? report.offload;
    const rawWarmUpMs = tgRow?.warmUpMs ?? ppRow?.warmUpMs ?? report.warmUpMs;
    const rawLoadTimeMs = tgRow?.loadTimeMs ?? ppRow?.loadTimeMs ?? report.loadTimeMs;

    const metrics: BenchmarkMetrics = {
      prefillTokPerSec: ppRow ? ppRow.tokPerSec : 0,
      genTokPerSec: tgRow ? tgRow.tokPerSec : 0,
      device: model.device,
      ...(model.tensorSplit ? { tensorSplit: model.tensorSplit } : {}),
      ...(offload?.layersOffloaded !== undefined ? { layersOffloaded: offload.layersOffloaded } : {}),
      ...(offload?.layersTotal !== undefined ? { layersTotal: offload.layersTotal } : {}),
      ...(offload?.offloadPercent !== undefined ? { offloadPercent: offload.offloadPercent } : {}),
      ...(typeof rawWarmUpMs === "number" ? { warmUpMs: rawWarmUpMs, htpWarmUpMs: rawWarmUpMs } : {}),
      ...(typeof rawLoadTimeMs === "number" ? { loadTimeMs: rawLoadTimeMs } : {}),
      ...(offload ? { offload } : {}),
      npuWatts: ppRow?.npuW ?? tgRow?.npuW ?? undefined,
      gpuWatts: ppRow?.gpuW ?? tgRow?.gpuW ?? undefined,
      socWatts: ppRow?.socW ?? tgRow?.socW ?? undefined,
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
      ...(model.tensorSplit ? { tensorSplit: model.tensorSplit } : {}),
      contextWindow: model.contextWindow,
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
