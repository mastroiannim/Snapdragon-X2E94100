import { describe, expect, it, vi } from "vitest";
import { startModelWatcher } from "../src/watcher.js";
import { okExec, recordingExec } from "./helpers.js";

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
      modelsDir: "C:/models",
      workspaceDir: "C:/workspace",
      listDir,
      exists,
      exec,
      readFile,
      writeFile,
      registryPath: "C:/registry.json",
      intervalMs: 100_000,
      enableAutoBenchmark: true,
      onQualified,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("nuovo-modello");
      expect(onQualified).toHaveBeenCalledWith("nuovo-modello", true);
      expect(storage.get("C:/registry.json")).toContain("nuovo-modello");
    } finally {
      watcher.stop();
    }
  });

  it("senza enableAutoBenchmark (default false): scansiona ma non avvia benchmark", async () => {
    const listDir = vi.fn(async () => ["nuovo-modello.gguf"]);
    const exists = vi.fn(async () => true);
    const { fn: exec, calls } = recordingExec(() => okExec(""));
    const onQualified = vi.fn();

    const watcher = startModelWatcher({
      modelsDir: "C:/models",
      workspaceDir: "C:/workspace",
      listDir,
      exists,
      exec,
      readFile: vi.fn(async () => "{}"),
      registryPath: "C:/registry.json",
      intervalMs: 100_000,
      onQualified,
    });

    try {
      const discovered = await watcher.checkNow();
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("nuovo-modello");
      expect(onQualified).not.toHaveBeenCalled();
      // inspect-gguf.ps1 puo' essere invocato per i metadati, ma nessun benchmark-hexagon.ps1 viene eseguito
      expect(
        calls.filter((c) =>
          c.args.some((a) => a.includes("benchmark-hexagon")),
        ),
      ).toHaveLength(0);
    } finally {
      watcher.stop();
    }
  });

  it("gestisce errori invocando onError senza crashare", async () => {
    const listDir = vi.fn(async () => {
      throw new Error("Disk read error");
    });
    const exists = vi.fn(async () => true);
    const readFile = vi.fn(async () => "{}");
    const onError = vi.fn();

    const watcher = startModelWatcher({
      modelsDir: "C:/models",
      workspaceDir: "C:/workspace",
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
        modelsDir: "C:/models",
        workspaceDir: "C:/workspace",
        listDir,
        exists,
        exec,
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
