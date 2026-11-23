/**
 * health.ts — Polling HTTP di readiness del router llama-server.
 *
 * L'allocazione del grafo HTP sulla NPU richiede warm-up: si ritenta ogni
 * 1000 ms fino a 30 tentativi (30 s) prima di dichiarare il timeout.
 */
import { nodeNow, nodeSleep } from "./os.js";
import { ROUTER_HOST, ROUTER_PORT } from "./process.js";
import type { FetchFn, NowFn, SleepFn } from "./types.js";

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
}

export const HEALTH_INTERVAL_MS = 1_000;
export const HEALTH_MAX_ATTEMPTS = 30;

export async function waitForHealth(options: HealthOptions): Promise<HealthResult> {
  const url = options.url ?? `http://${ROUTER_HOST}:${ROUTER_PORT}/health`;
  const interval = options.intervalMs ?? HEALTH_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? HEALTH_MAX_ATTEMPTS;
  const sleep = options.sleep ?? nodeSleep;
  const now = options.now ?? nodeNow;
  let lastError = "nessuna risposta";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const start = now();
    try {
      const response = await options.fetch(url);
      if (response.status === 200) {
        return { ready: true, attempts: attempt, latencyMs: now() - start };
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
