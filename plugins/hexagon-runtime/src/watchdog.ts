/**
 * watchdog.ts — Sorveglianza periodica del router llama-server.
 *
 * Loop non sovrapposto (catena di setTimeout): a ogni tick sonda /health;
 * se il server e' "down" tenta il recupero (ensureServer + waitForHealth),
 * se e' "loading" (warm-up NPU, 503) attende senza riavviare. Gli errori
 * di recupero sono notificati, mai silenziati ne' fatali per il loop.
 */

export const WATCHDOG_INTERVAL_MS = 15_000;

export type WatchdogProbe = () => Promise<"ready" | "loading" | "down">;

export interface WatchdogOptions {
  probe: WatchdogProbe;
  recover: () => Promise<unknown>;
  intervalMs?: number;
  /** Timer iniettabili per i test (default: setTimeout/clearTimeout globali). */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

export interface WatchdogHandle {
  stop(): void;
  readonly running: boolean;
}

export function startWatchdog(options: WatchdogOptions): WatchdogHandle {
  const interval = options.intervalMs ?? WATCHDOG_INTERVAL_MS;
  const setTimer =
    options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let stopped = false;
  let handle: unknown;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const state = await options.probe();
      if (state === "down" && !stopped) {
        await options.recover();
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!stopped) {
      handle = setTimer(() => void tick(), interval);
    }
  };

  handle = setTimer(() => void tick(), interval);
  return {
    stop() {
      stopped = true;
      clearTimer(handle);
    },
    get running() {
      return !stopped;
    },
  };
}
