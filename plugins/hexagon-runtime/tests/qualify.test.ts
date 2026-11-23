import { describe, expect, it, vi } from "vitest";
import {
  defaultRegistryPath,
  loadRegistry,
  qualifyModel,
  saveRegistry,
  type QualificationProfile,
} from "../src/qualify.js";
import type { DiscoveredModel } from "../src/discovery.js";
import { okExec, recordingExec } from "./helpers.js";

const BENCH_REPORT = `# Benchmark & PMIC Energy Report
| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`test.gguf\` | **HTP0** | \`pp512\` | **850.5** ± 2 | 14.5 | 0.5 | 3.0 | 2.0 | 1.0 | **21.0** | **28.0** |
| \`test.gguf\` | **HTP0** | \`tg128\` | **45.0** ± 1 | 14.0 | 0.5 | 3.0 | 2.0 | 1.0 | **20.5** | **27.5** |
`;

describe("qualify.ts — loadRegistry e saveRegistry", () => {
  it("loadRegistry: ritorna record vuoto se il file non esiste", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const reg = await loadRegistry("C:/fake/registry.json", { readFile });
    expect(reg).toEqual({});
  });

  it("saveRegistry e loadRegistry: persistenza corretta", async () => {
    const storage = new Map<string, string>();
    const readFile = vi.fn(async (p: string) => storage.get(p) ?? "");
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const profile: QualificationProfile = {
      modelId: "test-model",
      status: "certified",
      device: "HTP0",
      contextWindow: 65536,
      timestamp: "2026-11-23T21:00:00Z",
    };

    await saveRegistry({ "test-model": profile }, "C:/fake/registry.json", { writeFile });
    const loaded = await loadRegistry("C:/fake/registry.json", { readFile });
    expect(loaded["test-model"].status).toBe("certified");
    expect(loaded["test-model"].contextWindow).toBe(65536);
  });

  it("defaultRegistryPath: sotto LocalAppData/Hexagon", () => {
    const path = defaultRegistryPath("C:/Users/test/AppData/Local");
    expect(path).toContain("Hexagon");
    expect(path).toContain("models-registry.json");

    const fallbackPath = defaultRegistryPath();
    expect(fallbackPath).toContain("models-registry.json");
  });
});

describe("qualifyModel", () => {
  const model: DiscoveredModel = {
    id: "test-model",
    fileName: "test-model.gguf",
    filePath: "C:/models/test-model.gguf",
    sizeGb: 5.0,
    status: "untested",
    device: "HTP0",
    contextWindow: 65536,
    strategy: "HTP0 dense",
  };

  it("qualifica con successo un modello estraendo metriche PMIC e throughput", async () => {
    const storage = new Map<string, string>();
    const { fn: exec } = recordingExec(() => okExec(""));
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return BENCH_REPORT;
      return storage.get(p) ?? "{}";
    });
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const result = await qualifyModel({
      model,
      workspaceDir: "C:/workspace",
      exec,
      readFile,
      writeFile,
      registryPath: "C:/registry.json",
    });

    expect(result.status).toBe("certified");
    expect(result.metrics?.prefillTokPerSec).toBe(850.5);
    expect(result.metrics?.genTokPerSec).toBe(45.0);
    expect(result.metrics?.npuWatts).toBe(14.5);
    expect(storage.get("C:/registry.json")).toContain("test-model");
  });

  it("registra incompatible con errore in caso di crash", async () => {
    const storage = new Map<string, string>();
    const { fn: exec } = recordingExec(() => ({
      code: 1,
      stdout: "",
      stderr: "FastRPC Error 0xC0000005",
    }));
    const readFile = vi.fn(async (p: string) => storage.get(p) ?? "{}");
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const result = await qualifyModel({
      model,
      workspaceDir: "C:/workspace",
      exec,
      readFile,
      writeFile,
      registryPath: "C:/registry.json",
    });

    expect(result.status).toBe("incompatible");
    expect(result.error).toContain("0xC0000005");
    expect(storage.get("C:/registry.json")).toContain("incompatible");
  });
});
