import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("loadRegistry: ritorna record vuoto se il file non esiste", async () => {
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const reg = await loadRegistry("/virtual/registry.json", { readFile });
    expect(reg).toEqual({});
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

  it("gestisce report vuoto senza righe pp/tg (metriche a 0, potenze undefined)", async () => {
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

    expect(result.status).toBe("certified");
    expect(result.metrics?.prefillTokPerSec).toBe(0);
    expect(result.metrics?.genTokPerSec).toBe(0);
    expect(result.metrics?.npuWatts).toBeUndefined();
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
});
