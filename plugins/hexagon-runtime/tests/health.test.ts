import { describe, expect, it, vi } from "vitest";
import { waitForHealth } from "../src/health.js";
import { fakeResponse, recordingFetch } from "./helpers.js";

function fakeClock() {
  let current = 1_000;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("waitForHealth", () => {
  it("successo immediato su HTTP 200", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    const clock = fakeClock();
    const result = await waitForHealth({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ ready: true, attempts: 1, latencyMs: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:18803/health");
    expect(clock.sleeps).toEqual([]);
  });

  it("retry durante il warm-up NPU: 503, 503, poi 200", async () => {
    const statuses = [503, 503, 200];
    let index = 0;
    const { fn: fetch, calls } = recordingFetch(() =>
      fakeResponse(statuses[index++]),
    );
    const clock = fakeClock();
    const result = await waitForHealth({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.ready).toBe(true);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it("errori di rete ritentati fino al successo", async () => {
    let attempt = 0;
    const { fn: fetch } = recordingFetch(() => {
      attempt += 1;
      if (attempt < 3) throw new Error("ECONNREFUSED");
      return fakeResponse(200);
    });
    const clock = fakeClock();
    const result = await waitForHealth({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.attempts).toBe(3);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it("timeout dopo 30 tentativi falliti con errore descrittivo", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(503));
    const clock = fakeClock();
    await expect(
      waitForHealth({ fetch, sleep: clock.sleep, now: clock.now }),
    ).rejects.toThrow(/dopo 30 tentativi \(30s\).*HTTP 503/);
    expect(calls).toHaveLength(30);
    expect(clock.sleeps).toHaveLength(29);
    expect(clock.sleeps.every((ms) => ms === 1000)).toBe(true);
  });

  it("timeout con errori di rete: ultimo messaggio preservato", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const clock = fakeClock();
    await expect(
      waitForHealth({ fetch, sleep: clock.sleep, now: clock.now, maxAttempts: 3 }),
    ).rejects.toThrow(/dopo 3 tentativi.*ECONNREFUSED/);
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it("rifiuto non-Error: convertito a stringa", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw "guasto stringa";
    });
    const clock = fakeClock();
    await expect(
      waitForHealth({ fetch, sleep: clock.sleep, now: clock.now, maxAttempts: 2 }),
    ).rejects.toThrow(/guasto stringa/);
  });

  it("url e intervallo personalizzati", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    const clock = fakeClock();
    await waitForHealth({
      fetch,
      url: "http://127.0.0.1:19999/health",
      intervalMs: 50,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(calls[0].url).toBe("http://127.0.0.1:19999/health");
  });

  it("latenza misurata sulla richiesta riuscita", async () => {
    const clock = fakeClock();
    const { fn: fetch } = recordingFetch(async () => {
      clock.advance(120);
      return fakeResponse(200);
    });
    const result = await waitForHealth({
      fetch,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result.latencyMs).toBe(120);
  });

  it("sleep/now di default: retry reale ogni 1000ms", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const { fn: fetch } = recordingFetch(() => {
        attempt += 1;
        return attempt < 2 ? fakeResponse(503) : fakeResponse(200);
      });
      const promise = waitForHealth({ fetch });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.attempts).toBe(2);
      expect(result.ready).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
