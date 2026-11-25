/**
 * health.ts — Polling HTTP di readiness del router llama-server e telemetria reale.
 *
 * L'allocazione del grafo HTP sulla NPU richiede warm-up: si ritenta ogni
 * 1000 ms fino a 30 tentativi (30 s) prima di dichiarare il timeout.
 */
import { join } from "node:path";
import { nodeNow, nodeSleep } from "./os.js";
import { ROUTER_HOST, ROUTER_PORT } from "./process.js";
import {
  parseLlamaLogs,
  type RealOffloadTelemetry,
  type ThroughputTelemetry,
  type WarmUpTelemetry,
} from "./telemetry.js";
import type { ExistsFn, FetchFn, ListDirFn, NowFn, ReadFileFn, SleepFn } from "./types.js";

export interface HealthOptions {
  fetch: FetchFn;
  url?: string;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: SleepFn;
  now?: NowFn;
}

export interface HealthResult {
  ready: boolean;
  attempts: number;
  latencyMs: number;
  warmUpMs?: number;
}

export const HEALTH_INTERVAL_MS = 1_000;
export const HEALTH_MAX_ATTEMPTS = 30;

export async function waitForHealth(options: HealthOptions): Promise<HealthResult> {
  const url = options.url ?? `http://${ROUTER_HOST}:${ROUTER_PORT}/health`;
  const interval = options.intervalMs ?? HEALTH_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? HEALTH_MAX_ATTEMPTS;
  const sleep = options.sleep ?? nodeSleep;
  const now = options.now ?? nodeNow;
  const cycleStart = now();
  let lastError = "nessuna risposta";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = now();
    try {
      const response = await options.fetch(url);
      if (response.status === 200) {
        const end = now();
        const totalMs = end - cycleStart;
        return {
          ready: true,
          attempts: attempt,
          latencyMs: end - start,
          ...(attempt > 1 ? { warmUpMs: totalMs } : {}),
        };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) await sleep(interval);
  }
  throw new Error(
    `Health check fallito dopo ${maxAttempts} tentativi ` +
      (`(${(maxAttempts * interval) / 1000}s): ${lastError}. `) +
      "Il grafo HTP potrebbe non essersi inizializzato: verificare ADSP_LIBRARY_PATH e i driver.",
  );
}

export type RouterHealthState = "ready" | "loading" | "down";

export interface ProbeHealthOptions {
  fetch: FetchFn;
  url?: string;
  timeoutMs?: number;
}

/**
 * Sonda singola per il watchdog: distingue il warm-up NPU (503 = "loading",
 * non riavviare) dal server morto (errore di rete = "down", recuperare).
 */
export async function probeHealth(
  options: ProbeHealthOptions,
): Promise<RouterHealthState> {
  const url = options.url ?? `http://${ROUTER_HOST}:${ROUTER_PORT}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await options.fetch(url, { signal: controller.signal });
    return response.status === 200 ? "ready" : "loading";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

/** Informazioni di offload reale estratte dai log di llama-server / llama-bench. */
export type OffloadInfo = RealOffloadTelemetry;

/** Tempi di warm-up HTP separati dal throughput di inferenza. */
export type WarmUpInfo = WarmUpTelemetry;

export interface StatusReport {
  router: { host: string; port: number; active: boolean; ready: boolean };
  latencyMs: number | null;
  loadedModels: string[];
  offload?: RealOffloadTelemetry[];
  warmUp?: WarmUpTelemetry;
  throughput?: ThroughputTelemetry;
  runtime?: unknown;
  error?: string;
}

export interface StatusOptions {
  fetch: FetchFn;
  port?: number;
  host?: string;
  now?: NowFn;
  logPath?: string;
  logsDir?: string;
  readFile?: ReadFileFn;
  exists?: ExistsFn;
  listDir?: ListDirFn;
}

async function readTelemetryFromLogs(
  options: Pick<StatusOptions, "logPath" | "logsDir" | "readFile" | "exists" | "listDir">,
  loadedModels: string[],
): Promise<{
  offload: RealOffloadTelemetry[];
  warmUp?: WarmUpTelemetry;
  throughput?: ThroughputTelemetry;
}> {
  if (!options.readFile) {
    return { offload: [] };
  }

  const parsedEntries: Array<ReturnType<typeof parseLlamaLogs>> = [];

  if (options.logPath) {
    const serverLogExists = options.exists ? await options.exists(options.logPath).catch(() => false) : true;
    if (serverLogExists) {
      try {
        const text = await options.readFile(options.logPath);
        if (text.trim()) {
          parsedEntries.push(parseLlamaLogs(text, "llama-server.log"));
        }
      } catch {
        /* log llama-server non ancora creato o illeggibile */
      }
    }
  }

  // Fallback / integrazione da log llama-bench recenti se disponibili nella directory log
  if (options.logsDir && options.listDir) {
    const dirExists = options.exists ? await options.exists(options.logsDir).catch(() => false) : true;
    if (dirExists) {
      try {
        const files = (await options.listDir(options.logsDir))
          .filter((name) => name.endsWith("_stderr.txt"))
          .sort()
          .slice(-5)
          .reverse();
        for (const file of files) {
          try {
            const text = await options.readFile(join(options.logsDir, file));
            if (text.trim()) {
              parsedEntries.push(parseLlamaLogs(text, file));
            }
          } catch {
            /* ignora log singolo illeggibile */
          }
        }
      } catch {
        /* directory log illeggibile */
      }
    }
  }

  if (parsedEntries.length === 0) {
    return { offload: [] };
  }

  const offloadByModel = new Map<string, RealOffloadTelemetry>();
  const anonymousOffloads: RealOffloadTelemetry[] = [];
  let bestWarmUp: WarmUpTelemetry | undefined;
  let bestThroughput: ThroughputTelemetry | undefined;

  for (const parsed of parsedEntries) {
    if (!bestWarmUp && (parsed.warmUp.htpWarmUpMs !== null || parsed.warmUp.loadTimeMs !== null)) {
      bestWarmUp = parsed.warmUp;
    }
    if (
      !bestThroughput &&
      (parsed.throughput.promptEvalTokPerSec !== null || parsed.throughput.evalTokPerSec !== null)
    ) {
      bestThroughput = parsed.throughput;
    }
    for (const [mid, item] of Object.entries(parsed.perModel)) {
      if (!offloadByModel.has(mid)) {
        offloadByModel.set(mid, item.offload);
      }
    }
    if (parsed.offload && !parsed.offload.modelId) {
      anonymousOffloads.push(parsed.offload);
    }
  }

  const offload: RealOffloadTelemetry[] = [];
  for (const mid of loadedModels) {
    const match = offloadByModel.get(mid);
    if (match) offload.push(match);
  }
  for (const [mid, item] of offloadByModel.entries()) {
    if (!loadedModels.includes(mid)) offload.push(item);
  }
  if (offload.length === 0 && anonymousOffloads.length > 0) {
    offload.push(anonymousOffloads[0]);
  }

  return {
    offload,
    ...(bestWarmUp ? { warmUp: bestWarmUp } : {}),
    ...(bestThroughput ? { throughput: bestThroughput } : {}),
  };
}

/** Stato router: latenza /health, modelli caricati via /v1/models, offload reale e warm-up HTP da log. */
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

    const telemetry = await readTelemetryFromLogs(options, loadedModels);
    return {
      router: { host, port, active: true, ready: health.status === 200 },
      latencyMs,
      loadedModels,
      ...(telemetry.offload.length > 0 ? { offload: telemetry.offload } : {}),
      ...(telemetry.warmUp ? { warmUp: telemetry.warmUp } : {}),
      ...(telemetry.throughput ? { throughput: telemetry.throughput } : {}),
    };
  } catch (error) {
    const telemetry = await readTelemetryFromLogs(options, []);
    return {
      router: { host, port, active: false, ready: false },
      latencyMs: null,
      loadedModels: [],
      ...(telemetry.offload.length > 0 ? { offload: telemetry.offload } : {}),
      ...(telemetry.warmUp ? { warmUp: telemetry.warmUp } : {}),
      ...(telemetry.throughput ? { throughput: telemetry.throughput } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
