import { describe, expect, it, vi } from "vitest";
import { collectStatus, probeHealth, waitForHealth } from "../src/health.js";
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

describe("probeHealth", () => {
  it("HTTP 200: ready", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    expect(await probeHealth({ fetch })).toBe("ready");
    expect(calls[0].url).toBe("http://127.0.0.1:18803/health");
  });

  it("HTTP 503 (warm-up NPU): loading, non down", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(503));
    expect(await probeHealth({ fetch })).toBe("loading");
  });

  it("errore di rete: down", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeHealth({ fetch })).toBe("down");
  });

  it("timeout della sonda: down senza blocchi", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await probeHealth({ fetch, timeoutMs: 20 })).toBe("down");
  });

  it("url personalizzato", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    await probeHealth({ fetch, url: "http://127.0.0.1:19999/health" });
    expect(calls[0].url).toBe("http://127.0.0.1:19999/health");
  });
});

describe("collectStatus — offload reale e warm-up HTP da log", () => {
  it("waitForHealth espone warmUpMs quando servono più tentativi (503 -> 200)", async () => {
    let attempt = 0;
    const { fn: fetch } = recordingFetch(() => {
      attempt += 1;
      return attempt < 2 ? fakeResponse(503) : fakeResponse(200);
    });
    const clock = fakeClock();
    const res = await waitForHealth({ fetch, sleep: clock.sleep, now: clock.now });
    expect(res.warmUpMs).toBe(1000);
  });

  it("legge llama-server.log e fallback *_stderr.txt senza chiamare probe extra", async () => {
    const serverLog = [
      "ggml-hex: Hexagon Arch version v81, DMA64 enabled",
      "srv loading model 'Qwen3.8-27B-Q4_0'",
      "load_tensors: offloaded 64/64 layers to GPU",
      "load_tensors: HTP0 model buffer size = 14000.00 MiB",
      "load_tensors: CPU model buffer size = 200.00 MiB",
      "llama_perf_context_print: load time = 2100.00 ms",
      "llama_perf_context_print: prompt eval time = 500.00 ms / 512 tokens (0.98 ms per token, 1024.00 tokens per second)",
      "llama_perf_context_print: eval time = 1000.00 ms / 25 runs (40.00 ms per token, 25.00 tokens per second)",
    ].join("\n");
    const benchLog = [
      "load_tensors: layer 0 assigned to device HTP0",
      "load_tensors: offloaded 24/24 layers to GPU",
      "llama_perf_context_print: load time = 450.00 ms",
    ].join("\n");

    const { fn: fetch, calls } = recordingFetch((call) =>
      call.url.endsWith("/v1/models")
        ? fakeResponse(200, { data: [{ id: "Qwen3.8-27B-Q4_0" }] })
        : fakeResponse(200),
    );
    const status = await collectStatus({
      fetch,
      now: () => 100,
      logPath: "/virtual/logs/llama-server.log",
      logsDir: "/virtual/logs",
      exists: async (p) => p === "/virtual/logs/llama-server.log" || p === "/virtual/logs",
      listDir: async () => ["run1_stderr.txt", "run1_stdout.json"],
      readFile: async (p) => {
        if (p.endsWith("llama-server.log")) return serverLog;
        if (p.endsWith("run1_stderr.txt")) return benchLog;
        throw new Error("ENOENT");
      },
    });
    expect(calls).toHaveLength(2);
    expect(status.offload?.[0].modelId).toBe("Qwen3.8-27B-Q4_0");
    expect(status.warmUp?.htpWarmUpMs).toBe(2100);
    expect(status.throughput).toEqual({
      promptEvalTokPerSec: 1024,
      evalTokPerSec: 25,
    });

    // Offline ma con soli log anonimi bench fallback
    const { fn: downFetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const offlineStatus = await collectStatus({
      fetch: downFetch,
      logPath: "/virtual/logs/missing.log",
      logsDir: "/virtual/logs",
      exists: async (p) => p === "/virtual/logs",
      listDir: async () => ["run1_stderr.txt", "broken_stderr.txt"],
      readFile: async (p) => {
        if (p.endsWith("run1_stderr.txt")) return benchLog;
        throw new Error("unreadable");
      },
    });
    expect(offlineStatus.router.active).toBe(false);
    expect(offlineStatus.offload?.[0].layersOffloaded).toBe(24);
    expect(offlineStatus.warmUp?.loadTimeMs).toBe(450);

    // Gestisce listDir che lancia errore in modo sicuro
    const safeEmpty = await collectStatus({
      fetch,
      logsDir: "/virtual/broken-logs",
      exists: async () => true,
      listDir: async () => {
        throw new Error("EACCES");
      },
      readFile: async () => "",
    });
    expect(safeEmpty.offload).toBeUndefined();
  });
});
