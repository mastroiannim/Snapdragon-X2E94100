import { describe, expect, it, vi } from "vitest";
import { startModelWatcher } from "../src/watcher.js";
import { okExec, recordingExec, recordingFetch, recordingSpawn, routerResponse } from "./helpers.js";

const BENCH_REPORT = `# Benchmark Report
| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`nuovo.gguf\` | **HTP0** | \`pp512\` | **750.0** ± 2 | 14.0 | 0.5 | 3.0 | 2.0 | 1.0 | **20.5** | **27.5** |
`;

describe("watcher.ts — startModelWatcher", () => {
  it("scansiona e qualifica modelli non testati notificando onQualified", async () => {
    const listDir = vi.fn(async () => ["nuovo-modello.gguf"]);
    const exists = vi.fn(async () => true);
    const storage = new Map<string, string>();
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return BENCH_REPORT;
      return storage.get(p) ?? "{}";
    });
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const { fn: exec } = recordingExec(() => okExec(""));
    const onQualified = vi.fn();

    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      listDir,
      exists,
      exec,
      readFile,
      writeFile,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
      intervalMs: 100_000,
      enableAutoBenchmark: true,
      onQualified,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("nuovo-modello");
      expect(onQualified).toHaveBeenCalledWith("nuovo-modello", true);
      expect(storage.get("/virtual/registry.json")).toContain("nuovo-modello");
    } finally {
      watcher.stop();
    }
  });

  it("sincronizza INI, notifica onModelsDiscovered e ricarica router stale se configurato", async () => {
    const listDir = vi.fn(async () => ["nuovo-modello.gguf"]);
    const exists = vi.fn(async (p: string) => !p.endsWith("kilo.json"));
    const storage = new Map<string, string>([
      ["/virtual/hexagon-models.ini", "[*]\nthreads = 12\n"],
      ["/virtual/registry.json", "{}"],
    ]);
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return BENCH_REPORT;
      return storage.get(p) ?? "{}";
    });
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    let killed = false;
    const { fn: fetch } = recordingFetch((call) => {
      if (killed) throw new Error("ECONNREFUSED");
      if (call.url.endsWith("/v1/models")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ object: "list", data: [] }),
          text: async () => "",
        };
      }
      return routerResponse(call.url);
    });
    const { fn: spawn, calls: spawnCalls } = recordingSpawn(3333);
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "taskkill" || call.command === "pkill") {
        killed = true;
      }
      if (call.args.some((a) => a.includes("inspect-gguf"))) {
        return okExec(
          JSON.stringify({
            architecture: "llama",
            model_name: "Nuovo",
            context_length: 65536,
            embedding_length: 4096,
            block_count: 32,
            head_count: 32,
            head_count_kv: 8,
            expert_count: 0,
            expert_used_count: 0,
            sliding_window: 0,
            file_type: 2,
            file_size_bytes: 4_000_000_000,
            size_gb: 3.72,
            quant_name: "Q4_0",
            is_moe: false,
          }),
        );
      }
      return okExec("");
    });

    const onModelsDiscovered = vi.fn();
    const onQualified = vi.fn();

    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      iniPath: "/virtual/hexagon-models.ini",
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      runtimeDir: "/virtual/bin",
      serverExe: "/virtual/bin/llama-server.exe",
      listDir,
      exists,
      exec,
      readFile,
      writeFile,
      mkdir: async () => {},
      fetch,
      spawn,
      sleep: async () => {},
      intervalMs: 100_000,
      enableAutoBenchmark: true,
      onModelsDiscovered,
      onQualified,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(discovered).toHaveLength(1);
      expect(onModelsDiscovered).toHaveBeenCalledWith(["nuovo-modello"]);
      expect(spawnCalls).toHaveLength(1);
      expect(onQualified).toHaveBeenCalledWith("nuovo-modello", true);
    } finally {
      watcher.stop();
    }
  });

  it("gestisce errori in syncDiscoveredModelsToIni tramite onError senza interrompere la scansione", async () => {
    const listDir = vi.fn(async () => ["nuovo-modello.gguf"]);
    const exists = vi.fn(async () => true);
    const readFile = vi.fn(async () => "{}");
    const writeFile = vi.fn(async () => {
      throw new Error("Errore scrittura INI");
    });
    const onError = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      iniPath: "/virtual/hexagon-models.ini",
      registryPath: "/virtual/registry.json",
      listDir,
      exists,
      exec: vi.fn(async () => okExec("")),
      readFile,
      writeFile,
      mkdir: async () => {},
      intervalMs: 100_000,
      onError,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(onError).toHaveBeenCalled();
      expect(discovered).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      watcher.stop();
    }
  });

  it("senza enableAutoBenchmark (default false): scansiona ma non avvia benchmark", async () => {
    const listDir = vi.fn(async () => ["nuovo-modello.gguf"]);
    const exists = vi.fn(async () => true);
    const { fn: exec, calls } = recordingExec(() => okExec(""));
    const onQualified = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      listDir,
      exists,
      exec,
      readFile: vi.fn(async () => "{}"),
      registryPath: "/virtual/registry.json",
      intervalMs: 100_000,
      onQualified,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("nuovo-modello");
      expect(onQualified).not.toHaveBeenCalled();
      expect(
        calls.filter((c) =>
          c.args.some((a) => a.includes("benchmark-hexagon")),
        ),
      ).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      watcher.stop();
    }
  });

  it("ignora checkNow concorrenti e chiamate dopo stop", async () => {
    let releaseDir!: () => void;
    const listDir = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          releaseDir = () => resolve([]);
        }),
    );
    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      listDir,
      exists: async () => true,
      exec: vi.fn(async () => okExec("")),
      readFile: async () => "{}",
      registryPath: "/virtual/registry.json",
      intervalMs: 100_000,
    });

    const first = watcher.checkNow();
    await vi.waitFor(() => expect(listDir).toHaveBeenCalledTimes(1));
    const second = await watcher.checkNow();
    expect(second).toEqual([]);
    releaseDir();
    await first;

    watcher.stop();
    expect(await watcher.checkNow()).toEqual([]);
  });

  it("notifica onQualified(..., false) se il benchmark fallisce e interrompe su stop", async () => {
    const listDir = vi.fn(async () => ["m1.gguf", "m2.gguf"]);
    const exists = vi.fn(async () => true);
    const onQualified = vi.fn();
    const storage = new Map<string, string>();
    let watcher!: ReturnType<typeof startModelWatcher>;
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.some((a) => a.includes("benchmark-hexagon"))) {
        watcher.stop();
        return { code: 1, stdout: "", stderr: "fail" };
      }
      return okExec("{}");
    });

    watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      listDir,
      exists,
      exec,
      readFile: async (p) => storage.get(p) ?? "{}",
      writeFile: async (p, c) => {
        storage.set(p, c);
      },
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
      intervalMs: 100_000,
      enableAutoBenchmark: true,
      onQualified,
    });

    await watcher.checkNow();
    expect(onQualified).toHaveBeenCalledTimes(1);
    expect(onQualified).toHaveBeenCalledWith("m1", false);
  });

  it("gestisce errori invocando onError senza crashare", async () => {
    const listDir = vi.fn(async () => {
      throw new Error("Disk read error");
    });
    const exists = vi.fn(async () => true);
    const readFile = vi.fn(async () => "{}");
    const onError = vi.fn();

    const watcher = startModelWatcher({
      modelsDir: "/virtual/models",
      workspaceDir: "/virtual/workspace",
      listDir,
      exists,
      exec: vi.fn(),
      readFile,
      intervalMs: 100_000,
      onError,
    });

    try {
      const res = await watcher.checkNow();
      expect(res).toEqual([]);
      expect(onError).toHaveBeenCalled();
    } finally {
      watcher.stop();
    }
  });

  it("esegue check automatico all'intervallo specificato", async () => {
    vi.useFakeTimers();
    try {
      const listDir = vi.fn(async () => []);
      const exists = vi.fn(async () => true);
      const exec = vi.fn(async () => okExec(""));

      const watcher = startModelWatcher({
        modelsDir: "/virtual/models",
        workspaceDir: "/virtual/workspace",
        listDir,
        exists,
        exec,
        readFile: async () => "{}",
        registryPath: "/virtual/registry.json",
        intervalMs: 500,
      });

      await vi.advanceTimersByTimeAsync(600);
      expect(listDir).toHaveBeenCalled();
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
