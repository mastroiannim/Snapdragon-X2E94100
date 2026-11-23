import { describe, expect, it, vi } from "vitest";
import { startWatchdog, WATCHDOG_INTERVAL_MS } from "../src/watchdog.js";

/** Timer fake: coda esplicita, nessun timer reale nella suite. */
function fakeTimers() {
  const queue: Array<{ id: number; callback: () => void; ms: number }> = [];
  const cleared = new Set<number>();
  let nextId = 1;
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, callback, ms });
      return id;
    },
    clearTimer: (handle: unknown) => {
      cleared.add(handle as number);
    },
    /** Esegue il prossimo tick e attende il completamento della catena async. */
    fire: async () => {
      const item = queue.shift();
      if (item && !cleared.has(item.id)) item.callback();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pending: () => queue.filter((item) => !cleared.has(item.id)).length,
    lastMs: () => queue[queue.length - 1]?.ms,
  };
}

describe("startWatchdog", () => {
  it("pianifica il primo tick all'intervallo configurato", () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => "ready" as const);
    const handle = startWatchdog({
      probe,
      recover: vi.fn(async () => undefined),
      intervalMs: 5000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(handle.running).toBe(true);
    expect(timers.pending()).toBe(1);
    expect(timers.lastMs()).toBe(5000);
    expect(probe).not.toHaveBeenCalled();
    handle.stop();
  });

  it("intervallo di default 15 s", () => {
    const timers = fakeTimers();
    const handle = startWatchdog({
      probe: vi.fn(async () => "ready" as const),
      recover: vi.fn(async () => undefined),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(timers.lastMs()).toBe(WATCHDOG_INTERVAL_MS);
    expect(WATCHDOG_INTERVAL_MS).toBe(15_000);
    handle.stop();
  });

  it("probe ready: nessun recupero, tick successivo pianificato", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => "ready" as const);
    const recover = vi.fn(async () => undefined);
    const handle = startWatchdog({
      probe,
      recover,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await timers.fire();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(recover).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);
    handle.stop();
  });

  it("probe loading (warm-up NPU): nessun riavvio intempestivo", async () => {
    const timers = fakeTimers();
    const recover = vi.fn(async () => undefined);
    const handle = startWatchdog({
      probe: vi.fn(async () => "loading" as const),
      recover,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await timers.fire();
    expect(recover).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(1);
    handle.stop();
  });

  it("probe down: recupero invocato e loop prosegue", async () => {
    const timers = fakeTimers();
    const recover = vi.fn(async () => undefined);
    const handle = startWatchdog({
      probe: vi.fn(async () => "down" as const),
      recover,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await timers.fire();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(1);
    await timers.fire();
    expect(recover).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("recupero fallito: onError notificato, loop non fatale", async () => {
    const timers = fakeTimers();
    const onError = vi.fn();
    const handle = startWatchdog({
      probe: vi.fn(async () => "down" as const),
      recover: vi.fn(async () => {
        throw new Error("porta occupata");
      }),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onError,
    });
    await timers.fire();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0])).toContain("porta occupata");
    expect(timers.pending()).toBe(1);
    handle.stop();
  });

  it("probe fallito: onError notificato, loop prosegue", async () => {
    const timers = fakeTimers();
    const onError = vi.fn();
    const handle = startWatchdog({
      probe: vi.fn(async () => {
        throw new Error("sonda rotta");
      }),
      recover: vi.fn(async () => undefined),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      onError,
    });
    await timers.fire();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(1);
    handle.stop();
  });

  it("stop: running false, timer cancellato, nessun altro tick", async () => {
    const timers = fakeTimers();
    const probe = vi.fn(async () => "ready" as const);
    const handle = startWatchdog({
      probe,
      recover: vi.fn(async () => undefined),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    handle.stop();
    expect(handle.running).toBe(false);
    await timers.fire();
    expect(probe).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it("stop durante il recupero: nessun tick successivo", async () => {
    const timers = fakeTimers();
    let handle: ReturnType<typeof startWatchdog>;
    const handleRef: { current?: ReturnType<typeof startWatchdog> } = {};
    const recover = vi.fn(async () => {
      handleRef.current?.stop();
    });
    handle = startWatchdog({
      probe: vi.fn(async () => "down" as const),
      recover,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    handleRef.current = handle;
    await timers.fire();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(handle.running).toBe(false);
    expect(timers.pending()).toBe(0);
  });

  it("nessuna sovrapposizione: il tick successivo attende il completamento del probe", async () => {
    const timers = fakeTimers();
    let release: (() => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<"ready">((resolve) => {
          release = () => resolve("ready");
        }),
    );
    const handle = startWatchdog({
      probe,
      recover: vi.fn(async () => undefined),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await timers.fire();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(timers.pending()).toBe(1);
    handle.stop();
  });
});
