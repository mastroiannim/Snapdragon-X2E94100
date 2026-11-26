import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRegistryPath,
  loadRegistry,
  matchesConfiguredProfile,
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

const tempRoots: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("qualify.ts — loadRegistry e saveRegistry", () => {
  it("loadRegistry: ritorna record vuoto se il file non esiste o contiene JSON non oggetto", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const reg = await loadRegistry("/virtual/registry.json", { readFile });
    expect(reg).toEqual({});

    expect(await loadRegistry("/v/null.json", { readFile: async () => "null" })).toEqual({});
    expect(await loadRegistry("/v/arr.json", { readFile: async () => "[]" })).toEqual({});
  });

  it("saveRegistry e loadRegistry: persistenza mockata con exists/mkdir", async () => {
    const storage = new Map<string, string>();
    const dirs = new Set<string>();
    const readFile = vi.fn(async (p: string) => storage.get(p) ?? "");
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });
    const exists = vi.fn(async (p: string) => dirs.has(p));
    const mkdir = vi.fn(async (p: string) => {
      dirs.add(p);
    });

    const profile: QualificationProfile = {
      modelId: "test-model",
      status: "certified",
      device: "HTP0",
      contextWindow: 65536,
      timestamp: "2026-11-23T21:00:00Z",
    };

    const regPath = join("/virtual/sub", "registry.json");
    await saveRegistry({ "test-model": profile }, regPath, { writeFile, exists, mkdir });
    expect(mkdir).toHaveBeenCalledTimes(1);

    // Secondo salvataggio: directory gia' esistente, nessun mkdir
    await saveRegistry({ "test-model": profile }, regPath, { writeFile, exists, mkdir });
    expect(mkdir).toHaveBeenCalledTimes(1);

    // Salvataggio con writeFile custom e senza mkdir su directory assente: no-op sicuro
    await saveRegistry({ "test-model": profile }, join("/virtual/other", "registry.json"), {
      writeFile,
      exists: async () => false,
    });

    const loaded = await loadRegistry(regPath, { readFile });
    expect(loaded["test-model"].status).toBe("certified");
    expect(loaded["test-model"].contextWindow).toBe(65536);
  });

  it("saveRegistry e loadRegistry su filesystem reale isolato con mkdtempSync", async () => {
    const root = makeTempDir("hexagon-qualify-");
    const regPath = join(root, "nested", "models-registry.json");
    const profile: QualificationProfile = {
      modelId: "real-fs-model",
      status: "certified",
      device: "HTP0",
      contextWindow: 65536,
      timestamp: "2026-11-25T10:00:00Z",
    };

    await saveRegistry({ "real-fs-model": profile }, regPath);
    expect(existsSync(regPath)).toBe(true);
    expect(JSON.parse(readFileSync(regPath, "utf-8"))["real-fs-model"].status).toBe("certified");

    const loaded = await loadRegistry(regPath);
    expect(loaded["real-fs-model"].contextWindow).toBe(65536);

    const missing = await loadRegistry(join(root, "missing.json"));
    expect(missing).toEqual({});
  });

  it("defaultRegistryPath: sotto LocalAppData/Hexagon e fallback con stringa vuota", () => {
    const path = defaultRegistryPath("C:/Users/test/AppData/Local");
    expect(path).toContain("Hexagon");
    expect(path).toContain("models-registry.json");

    const emptyFallback = defaultRegistryPath("");
    expect(emptyFallback).toContain(join("AppData", "Local", "Hexagon", "models-registry.json"));

    const fallbackPath = defaultRegistryPath();
    expect(fallbackPath).toContain("models-registry.json");
  });
});

describe("qualifyModel", () => {
  const model: DiscoveredModel = {
    id: "test-model",
    fileName: "test-model.gguf",
    filePath: "/virtual/models/test-model.gguf",
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
    const exists = vi.fn(async () => true);
    const mkdir = vi.fn(async () => {});

    const result = await qualifyModel({
      model,
      workspaceDir: "/virtual/ws",
      exec,
      readFile,
      writeFile,
      exists,
      mkdir,
      registryPath: "/virtual/registry.json",
    });

    expect(result.status).toBe("certified");
    expect(result.metrics?.prefillTokPerSec).toBe(850.5);
    expect(result.metrics?.genTokPerSec).toBe(45.0);
    expect(result.metrics?.npuWatts).toBe(14.5);
    expect(storage.get("/virtual/registry.json")).toContain("test-model");
  });

  it("rifiuta report vuoto senza righe valide marcandolo incompatible", async () => {
    const storage = new Map<string, string>();
    const { fn: exec } = recordingExec(() => okExec(""));
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return "";
      return storage.get(p) ?? "{}";
    });
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const result = await qualifyModel({
      model,
      workspaceDir: "/virtual/ws",
      exec,
      readFile,
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });

    expect(result.status).toBe("incompatible");
    expect(result.error).toContain("HTP0");
    expect(storage.get("/virtual/registry.json")).toContain("incompatible");
  });

  it("matchesConfiguredProfile e qualifyModel: passa -Device/-TensorSplit ed estrae esclusivamente il profilo configurato", async () => {
    expect(matchesConfiguredProfile("HTP0", "HTP0")).toBe(true);
    expect(matchesConfiguredProfile("HTP0 (100% NPU)", "HTP0")).toBe(true);
    expect(matchesConfiguredProfile("GPUOpenCL (100% GPU)", "HTP0")).toBe(false);
    expect(matchesConfiguredProfile("HTP0/GPUOpenCL (85/15)", "HTP0,GPUOpenCL", "85,15")).toBe(true);
    expect(matchesConfiguredProfile("HTP0/GPUOpenCL (85.00/15.00)", "HTP0,GPUOpenCL", "85,15")).toBe(true);
    expect(matchesConfiguredProfile("HTP0/GPUOpenCL (75/25)", "HTP0,GPUOpenCL", "85,15")).toBe(false);
    expect(matchesConfiguredProfile("HTP0/GPUOpenCL (75/25)", "HTP0,GPUOpenCL")).toBe(false);
    expect(matchesConfiguredProfile("HTP0/GPUOpenCL", "HTP0,GPUOpenCL")).toBe(true);
    expect(matchesConfiguredProfile("()", "HTP0")).toBe(false);

    const multiReport = `# Benchmark Report
| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`flint.gguf\` | **HTP0 (100% NPU)** | \`pp512\` | **111.0** ± 1 | 10.0 | 0.1 | 2.0 | 1.0 | 1.0 | **14.1** | **18.0** |
| \`flint.gguf\` | **HTP0 (100% NPU)** | \`tg128\` | **12.0** ± 1 | 9.5 | 0.1 | 2.0 | 1.0 | 1.0 | **13.7** | **17.5** |
| \`flint.gguf\` | **HTP0/GPUOpenCL (75/25)** | \`pp512\` | **222.0** ± 1 | 11.0 | 4.0 | 2.0 | 1.0 | 1.0 | **19.0** | **23.0** |
| \`flint.gguf\` | **HTP0/GPUOpenCL (85/15)** | \`pp512\` | **540.5** ± 2 | 15.2 | 3.1 | 2.5 | 2.0 | 1.0 | **23.8** | **29.0** |
| \`flint.gguf\` | **HTP0/GPUOpenCL (85/15)** | \`tg128\` | **38.4** ± 1 | 14.8 | 3.0 | 2.5 | 2.0 | 1.0 | **23.3** | **28.5** |
`;
    const hybridModel: DiscoveredModel = {
      id: "flint",
      fileName: "flint.gguf",
      filePath: "/virtual/models/flint.gguf",
      sizeGb: 23.3,
      status: "untested",
      device: "HTP0,GPUOpenCL",
      tensorSplit: "85,15",
      contextWindow: 131_072,
      strategy: "MoE 85/15",
    };

    const storage = new Map<string, string>();
    const { fn: exec, calls } = recordingExec(() => okExec(""));
    const readFile = vi.fn(async (p: string) => (p.endsWith(".md") ? multiReport : storage.get(p) ?? "{}"));
    const writeFile = vi.fn(async (p: string, c: string) => {
      storage.set(p, c);
    });

    const result = await qualifyModel({
      model: hybridModel,
      workspaceDir: "/virtual/ws",
      exec,
      readFile,
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });

    expect(calls[0].args).toContain("-Device");
    expect(calls[0].args[calls[0].args.indexOf("-Device") + 1]).toBe("HTP0,GPUOpenCL");
    expect(calls[0].args).toContain("-TensorSplit");
    expect(calls[0].args[calls[0].args.indexOf("-TensorSplit") + 1]).toBe("85,15");
    expect(result.status).toBe("certified");
    expect(result.metrics?.prefillTokPerSec).toBe(540.5);
    expect(result.metrics?.genTokPerSec).toBe(38.4);
    expect(result.metrics?.npuWatts).toBe(15.2);
    expect(result.metrics?.gpuWatts).toBe(3.1);
    expect(result.metrics?.socWatts).toBe(23.8);

    // Report contenente solo altro profilo -> incompatible, mai metriche sbagliate
    const wrongOnlyReport = `| Modello | Profilo | Test | Velocita' (t/s) |
| :--- | :--- | :---: | ---: |
| \`flint.gguf\` | **HTP0 (100% NPU)** | \`pp512\` | **111.0** |
| \`flint.gguf\` | **HTP0 (100% NPU)** | \`tg128\` | **12.0** |
`;
    const mismatchRes = await qualifyModel({
      model: hybridModel,
      workspaceDir: "/virtual/ws",
      exec,
      readFile: async (p) => (p.endsWith(".md") ? wrongOnlyReport : "{}"),
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });
    expect(mismatchRes.status).toBe("incompatible");
    expect(mismatchRes.tensorSplit).toBe("85,15");
    expect(mismatchRes.error).toContain("HTP0,GPUOpenCL (85,15)");

    // Report con sola riga tg128 e telemetria PMIC opzionale
    const tgOnlyReport = `| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`test.gguf\` | **HTP0 (100% NPU)** | \`tg128\` | **42.5** ± 1 | 12.0 | 0.4 | 2.0 | 1.0 | 1.0 | **16.4** | **21.0** |
`;
    const tgOnlyRes = await qualifyModel({
      model,
      workspaceDir: "/virtual/ws",
      exec,
      readFile: async (p) => (p.endsWith(".md") ? tgOnlyReport : "{}"),
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });
    expect(tgOnlyRes.status).toBe("certified");
    expect(tgOnlyRes.metrics?.prefillTokPerSec).toBe(0);
    expect(tgOnlyRes.metrics?.genTokPerSec).toBe(42.5);
    expect(tgOnlyRes.metrics?.npuWatts).toBe(12.0);
    expect(tgOnlyRes.metrics?.gpuWatts).toBe(0.4);
    expect(tgOnlyRes.metrics?.socWatts).toBe(16.4);
  });

  it("registra incompatible con errore in caso di crash (Error e non-Error)", async () => {
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
      workspaceDir: "/virtual/ws",
      exec,
      readFile,
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });

    expect(result.status).toBe("incompatible");
    expect(result.error).toContain("0xC0000005");
    expect(storage.get("/virtual/registry.json")).toContain("incompatible");

    const nonErrExec = vi.fn(async () => {
      throw "string-failure";
    });
    const nonErrResult = await qualifyModel({
      model,
      workspaceDir: "/virtual/ws",
      exec: nonErrExec,
      readFile,
      writeFile,
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });
    expect(nonErrResult.status).toBe("incompatible");
    expect(nonErrResult.error).toBe("string-failure");
  });

  it("propaga offload reale per-layer e htpWarmUpMs dal sidecar .telemetry.json", async () => {
    const storage = new Map<string, string>();
    const { fn: exec } = recordingExec(() => okExec(""));
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return BENCH_REPORT;
      if (p.endsWith(".telemetry.json")) {
        return JSON.stringify({
          results: [
            {
              model: "test.gguf",
              profile: "HTP0",
              test: "tg128",
              loadTimeMs: 1450,
              warmUpMs: 1480,
              offload: {
                layersOffloaded: 32,
                layersTotal: 32,
                offloadPercent: 100,
                layersByDevice: { HTP0: 32 },
                modelBuffersMiB: { HTP0: 4200 },
                kvBuffersMiB: { HTP0: 200 },
                computeBuffersMiB: { HTP0: 48 },
                cpuFallback: false,
                htpArch: "v81",
                dma64: true,
              },
            },
          ],
        });
      }
      return storage.get(p) ?? "{}";
    });
    const result = await qualifyModel({
      model,
      workspaceDir: "/virtual/ws",
      exec,
      readFile,
      writeFile: async (p, c) => {
        storage.set(p, c);
      },
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });

    expect(result.status).toBe("certified");
    expect(result.metrics?.prefillTokPerSec).toBe(850.5);
    expect(result.metrics?.genTokPerSec).toBe(45.0);
    expect(result.metrics?.layersOffloaded).toBe(32);
    expect(result.metrics?.layersTotal).toBe(32);
    expect(result.metrics?.offloadPercent).toBe(100);
    expect(result.metrics?.htpWarmUpMs).toBe(1480);
    expect(result.metrics?.loadTimeMs).toBe(1450);
    expect(result.metrics?.offload?.htpArch).toBe("v81");
  });

  it("qualifyModel passa il path relativo rispetto a modelsDir per modelli in sottodirectory", async () => {
    const subModel: DiscoveredModel = {
      id: "sub-model",
      fileName: "sub-model.gguf",
      filePath: "/virtual/models/org/repo/sub-model.gguf",
      sizeGb: 5.0,
      status: "untested",
      device: "HTP0",
      contextWindow: 65536,
      strategy: "HTP0 dense",
    };
    const { fn: exec, calls } = recordingExec(() => okExec(""));
    const result = await qualifyModel({
      model: subModel,
      workspaceDir: "/virtual/ws",
      modelsDir: "/virtual/models",
      exec,
      readFile: async (p) => (p.endsWith(".md") ? BENCH_REPORT.replace(/test-model\.gguf/g, "sub-model.gguf") : "{}"),
      writeFile: async () => {},
      exists: async () => true,
      mkdir: async () => {},
      registryPath: "/virtual/registry.json",
    });

    expect(result.status).toBe("certified");
    const modelsArg = calls[0].args[calls[0].args.indexOf("-Models") + 1] ?? "";
    expect(modelsArg.replace(/\\/g, "/")).toBe("org/repo/sub-model.gguf");
  });
});
