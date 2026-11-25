import { describe, expect, it, vi } from "vitest";
import {
  collectStatus,
  createHexagonTools,
  isBenchmarkActive,
  parseBenchReport,
  parseOptionalNumber,
  resetBenchmarkActiveForTests,
  resolveBenchScript,
  runBenchmark,
} from "../src/tools.js";
import { BUNDLED_BENCH_SCRIPT, defaultPaths } from "../src/process.js";
import type { SyncOutcome } from "../src/sync.js";
import { fakeResponse, okExec, recordingExec, recordingFetch, recordingSpawn } from "./helpers.js";

const BENCH_MARKDOWN = `# Benchmark & PMIC Energy Report (Auto-Generated)

| Modello | Profilo | Test | Velocita' (t/s) | NPU (W) | GPU (W) | CPU (W) | RAM (W) | INFRA (W) | SoC Tot (W) | Sistema (W) |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| \`\`Ornith-1.5-9B-Q4_0.gguf\`\` | **HTP0 (100% NPU)** | \`\`pp512\`\` | **750,5** ± 3 | 14,2 | 1,1 | 3,4 | 2,2 | 1,0 | **21,9** | **28,4** |
| \`\`Ornith-1.5-9B-Q4_0.gguf\`\` | **HTP0 (100% NPU)** | \`\`tg128\`\` | **46.2** ± 1 | 14 | N/D | 3 | 2 | 1 | **20** | **27** |
| \`flint.gguf\` | **GPUOpenCL (100% GPU)** | \`tg128\` | **12** ± 0 | N/D | N/D | N/D | N/D | N/D | **N/D** | **N/D** |
`;

const LEGACY_MARKDOWN = `| Modello | Profilo | Test | Velocita' (t/s) |
| :--- | :--- | :---: | ---: |
| \`m.gguf\` | **HTP0 (100% NPU)** | \`tg128\` | **40** |
`;

describe("collectStatus", () => {
  it("router pronto: latenza e modelli caricati", async () => {
    let current = 500;
    const { fn: fetch, calls } = recordingFetch((call) => {
      if (call.url.endsWith("/health")) {
        current += 42;
        return fakeResponse(200);
      }
      return fakeResponse(200, {
        data: [{ id: "Ornith-1.5-9B-Q4_0" }, { id: "" }, {}],
      });
    });
    const report = await collectStatus({ fetch, now: () => current });
    expect(report.router).toEqual({
      host: "127.0.0.1",
      port: 18803,
      active: true,
      ready: true,
    });
    expect(report.latencyMs).toBe(42);
    expect(report.loadedModels).toEqual(["Ornith-1.5-9B-Q4_0"]);
    // 2 sonde HTTP: /health + /v1/models (telemetria warm-up/offload letta dai log)
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:18803/health",
      "http://127.0.0.1:18803/v1/models",
    ]);
    expect(report.warmUp).toBeUndefined();
    expect(report.error).toBeUndefined();
  });

  it("warm-up: attivo ma non pronto (503)", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(503));
    const report = await collectStatus({ fetch, now: () => 0 });
    expect(report.router.active).toBe(true);
    expect(report.router.ready).toBe(false);
  });

  it("server spento: errore descrittivo e latenza null", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const report = await collectStatus({ fetch });
    expect(report.router.active).toBe(false);
    expect(report.router.ready).toBe(false);
    expect(report.latencyMs).toBeNull();
    expect(report.loadedModels).toEqual([]);
    expect(report.error).toBe("ECONNREFUSED");
  });

  it("rifiuto non-Error nello stato", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw "guasto";
    });
    const report = await collectStatus({ fetch });
    expect(report.error).toBe("guasto");
  });

  it("/v1/models illeggibile: stato router comunque valido", async () => {
    const { fn: fetch } = recordingFetch((call) => {
      if (call.url.endsWith("/health")) return fakeResponse(200);
      throw new Error("models down");
    });
    const report = await collectStatus({ fetch, now: () => 0 });
    expect(report.router.ready).toBe(true);
    expect(report.loadedModels).toEqual([]);
  });

  it("/v1/models non-ok: elenco vuoto", async () => {
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/health") ? fakeResponse(200) : fakeResponse(404),
    );
    const report = await collectStatus({ fetch, now: () => 0 });
    expect(report.loadedModels).toEqual([]);
  });

  it("/v1/models senza campo data: elenco vuoto", async () => {
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/health") ? fakeResponse(200) : fakeResponse(200, {}),
    );
    const report = await collectStatus({ fetch, now: () => 0 });
    expect(report.loadedModels).toEqual([]);
  });

  it("host/porta override", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    await collectStatus({ fetch, host: "127.0.0.2", port: 19000, now: () => 0 });
    expect(calls[0].url).toBe("http://127.0.0.2:19000/health");
  });

  it("runBenchmark integra sidecar .telemetry.json e fallback da stderr", async () => {
    const { fn: exec } = recordingExec(() => okExec(""));
    const readFile = vi.fn(async (p: string) => {
      if (p === "/virtual/tmp/bench.md") return BENCH_MARKDOWN;
      if (p === "/virtual/tmp/bench.md.telemetry.json") {
        return JSON.stringify({
          results: [
            {
              model: "Ornith-1.5-9B-Q4_0.gguf",
              profile: "HTP0 (100% NPU)",
              test: "pp512",
              loadTimeMs: 1120,
              warmUpMs: 1150,
              offload: {
                layersOffloaded: 36,
                layersTotal: 36,
                offloadPercent: 100,
                layersByDevice: { HTP0: 36 },
                modelBuffersMiB: { HTP0: 5100 },
                kvBuffersMiB: { HTP0: 256 },
                computeBuffersMiB: { HTP0: 64 },
                cpuFallback: false,
              },
            },
          ],
        });
      }
      return "";
    });
    const report = await runBenchmark({
      exec,
      readFile,
      workspaceDir: "/virtual/repo",
      reportPath: "/virtual/tmp/bench.md",
      exists: () => false,
    });
    expect(report.telemetryPath).toBe("/virtual/tmp/bench.md.telemetry.json");
    expect(report.offload?.layersOffloaded).toBe(36);
    expect(report.warmUpMs).toBe(1150);
    expect(report.loadTimeMs).toBe(1120);
    expect(report.results[0].offload?.layersByDevice).toEqual({ HTP0: 36 });

    // Fallback da stderr di llama-bench senza sidecar JSON
    const stderrReport = await runBenchmark({
      exec: async () => ({
        code: 0,
        stdout: "",
        stderr: [
          "load_tensors: offloaded 24/24 layers to GPU",
          "load_tensors: HTP0 model buffer size = 1800.00 MiB",
          "llama_perf_context_print: load time = 620.50 ms",
        ].join("\n"),
      }),
      readFile: async (p) => (p.endsWith(".md") ? BENCH_MARKDOWN : "{}"),
      workspaceDir: "/virtual/repo",
      reportPath: "/virtual/tmp/bench2.md",
      exists: () => false,
    });
    expect(stderrReport.offload?.offloadPercent).toBe(100);
    expect(stderrReport.warmUpMs).toBe(620.5);
    expect(stderrReport.loadTimeMs).toBe(620.5);
  });
});

describe("parseBenchReport", () => {
  it("estrae token/s dai profili, normalizzando la virgola decimale", () => {
    const rows = parseBenchReport(BENCH_MARKDOWN);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      model: "Ornith-1.5-9B-Q4_0.gguf",
      profile: "HTP0 (100% NPU)",
      test: "pp512",
      tokPerSec: 750.5,
      stdDev: 3,
      npuW: 14.2,
      gpuW: 1.1,
      cpuW: 3.4,
      memW: 2.2,
      infraW: 1,
      socW: 21.9,
      sysW: 28.4,
    });
    expect(rows[1].tokPerSec).toBe(46.2);
    expect(rows[2]).toMatchObject({ model: "flint.gguf", tokPerSec: 12 });
  });

  it("telemetria PMIC: N/D esplicito come null, mai zero", () => {
    const rows = parseBenchReport(BENCH_MARKDOWN);
    expect(rows[1].gpuW).toBeNull();
    expect(rows[1].npuW).toBe(14);
    expect(rows[1].socW).toBe(20);
    expect(rows[1].sysW).toBe(27);
    expect(rows[2].npuW).toBeNull();
    expect(rows[2].socW).toBeNull();
    expect(rows[2].sysW).toBeNull();
    expect(rows[2].stdDev).toBe(0);
  });

  it("report legacy senza colonne PMIC: potenze null", () => {
    const rows = parseBenchReport(LEGACY_MARKDOWN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      model: "m.gguf",
      profile: "HTP0 (100% NPU)",
      test: "tg128",
      tokPerSec: 40,
      stdDev: null,
      npuW: null,
      gpuW: null,
      cpuW: null,
      memW: null,
      infraW: null,
      socW: null,
      sysW: null,
    });
  });

  it("report vuoto o senza righe valide: nessun risultato", () => {
    expect(parseBenchReport("")).toEqual([]);
    expect(parseBenchReport("| a | b |\n| - | - |")).toEqual([]);
  });
});

describe("parseOptionalNumber", () => {
  it("numeri, virgola it-IT e grassetto markdown", () => {
    expect(parseOptionalNumber("14,2")).toBe(14.2);
    expect(parseOptionalNumber("**21,9**")).toBe(21.9);
    expect(parseOptionalNumber(" 3 ")).toBe(3);
  });
  it("N/D, vuoto, non numerico e undefined: null", () => {
    expect(parseOptionalNumber("N/D")).toBeNull();
    expect(parseOptionalNumber("**N/D**")).toBeNull();
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber("abc")).toBeNull();
    expect(parseOptionalNumber(undefined)).toBeNull();
  });
});

describe("runBenchmark", () => {
  const workspace = "/virtual/repo";

  it("lancia benchmark-hexagon.ps1 e legge il report", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec("=== RISULTATI ==="));
    const readFile = vi.fn(async () => BENCH_MARKDOWN);
    const report = await runBenchmark({
      exec,
      readFile,
      workspaceDir: workspace,
      model: "Ornith-1.5-9B-Q4_0",
      reportPath: "/virtual/tmp/bench.md",
      exists: () => false,
    });
    expect(report.model).toBe("Ornith-1.5-9B-Q4_0");
    expect(report.results).toHaveLength(3);
    expect(report.reportPath).toBe("/virtual/tmp/bench.md");
    const call = calls[0];
    expect(call.command).toBe("powershell");
    expect(call.args[call.args.indexOf("-File") + 1]).toBe(BUNDLED_BENCH_SCRIPT);
    expect(call.args[call.args.indexOf("-Models") + 1]).toBe(
      "Ornith-1.5-9B-Q4_0.gguf",
    );
    expect(call.args[call.args.indexOf("-Repetitions") + 1]).toBe("1");
    expect(readFile).toHaveBeenCalledWith("/virtual/tmp/bench.md");
  });

  it("modello .gguf preservato, repetitions override", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec());
    const readFile = vi.fn(async () => "");
    await runBenchmark({
      exec,
      readFile,
      workspaceDir: workspace,
      model: "x.gguf",
      repetitions: 3,
      reportPath: "r.md",
      exists: () => false,
    });
    const args = calls[0].args;
    expect(args[args.indexOf("-Models") + 1]).toBe("x.gguf");
    expect(args[args.indexOf("-Repetitions") + 1]).toBe("3");
  });

  it("senza modello: suite predefinita, report temporaneo", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec());
    const readFile = vi.fn(async () => "");
    const report = await runBenchmark({
      exec,
      readFile,
      workspaceDir: workspace,
      exists: () => false,
    });
    expect(calls[0].args).not.toContain("-Models");
    expect(report.model).toBe("suite predefinita");
    expect(report.reportPath).toContain("hexagon-bench-");
  });

  it("exit non-zero: errore propagato con fallback stdout/output vuoto", async () => {
    const { fn: exec } = recordingExec(() => ({
      code: 2,
      stdout: "",
      stderr: "modello mancante",
    }));
    const readFile = vi.fn(async () => "");
    await expect(
      runBenchmark({ exec, readFile, workspaceDir: workspace, reportPath: "r.md", exists: () => false }),
    ).rejects.toThrow(/benchmark-hexagon\.ps1 fallito \(exit 2\).*modello mancante/);

    const { fn: execStdout } = recordingExec(() => ({
      code: 3,
      stdout: "errore su stdout",
      stderr: "",
    }));
    await expect(
      runBenchmark({ exec: execStdout, readFile, workspaceDir: workspace, reportPath: "r.md", exists: () => false }),
    ).rejects.toThrow(/errore su stdout/);

    const { fn: execEmpty } = recordingExec(() => ({
      code: 4,
      stdout: "",
      stderr: "",
    }));
    await expect(
      runBenchmark({ exec: execEmpty, readFile, workspaceDir: workspace, reportPath: "r.md", exists: () => false }),
    ).rejects.toThrow(/output vuoto/);
  });

  it("blocca esecuzione di benchmark in parallelo e espone isBenchmarkActive", async () => {
    resetBenchmarkActiveForTests();
    expect(isBenchmarkActive()).toBe(false);
    let resolveP1!: (val: { code: number; stdout: string; stderr: string }) => void;
    const slowPromise = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      resolveP1 = resolve;
    });
    const exec = vi.fn(() => slowPromise);
    const readFile = vi.fn(async () => "");

    const p1 = runBenchmark({
      exec,
      readFile,
      workspaceDir: workspace,
      reportPath: "r1.md",
      exists: () => false,
    });
    expect(isBenchmarkActive()).toBe(true);

    await expect(
      runBenchmark({
        exec,
        readFile,
        workspaceDir: workspace,
        reportPath: "r2.md",
        exists: () => false,
      }),
    ).rejects.toThrow(/Benchmark già in esecuzione: l'avvio di benchmark in parallelo è bloccato/);

    resolveP1({ code: 0, stdout: "", stderr: "" });
    await p1;
    expect(isBenchmarkActive()).toBe(false);
  });
});

describe("createHexagonTools", () => {
  const syncOutcome: SyncOutcome = {
    updated: true,
    message: "allineato",
    files: ["ggml-hexagon.dll"],
    check: {
      geniexHash: "19cce6919",
      llamaCommit: "19cce6919",
      commitAligned: true,
      missingFiles: [],
      needsSync: false,
    },
  };

  function makeDeps() {
    const written = new Map<string, string>();
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/health")
        ? fakeResponse(200)
        : fakeResponse(200, { data: [{ id: "Ornith-1.5-9B-Q4_0" }] }),
    );
    const { fn: exec } = recordingExec(() => okExec());
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith(".md")) return BENCH_MARKDOWN;
      const found = written.get(p);
      if (found !== undefined) return found;
      if (p.endsWith("hexagon-models.ini")) {
        return "[Ornith-1.5-9B-Q4_0]\nmodel = /virtual/models/Ornith-1.5-9B-Q4_0.gguf\ndevice = HTP0\nctx-size = 65536\n";
      }
      throw new Error(`ENOENT: ${p}`);
    });
    const writeFile = vi.fn(async (p: string, content: string) => {
      written.set(p, content);
    });
    const listDir = vi.fn(async () => ["Ornith-1.5-9B-Q4_0.gguf"]);
    const exists = vi.fn(async (p: string) => {
      if (written.has(p)) return true;
      if (p.endsWith("kilo.json") || p.endsWith("kilo.jsonc")) return false;
      return true;
    });
    const mkdir = vi.fn(async () => {});
    const { fn: spawn } = recordingSpawn(4444);
    const sync = vi.fn(async () => syncOutcome);
    return {
      deps: {
        fetch,
        exec,
        readFile,
        writeFile,
        listDir,
        exists,
        mkdir,
        spawn,
        sleep: async () => {},
        now: () => 1_700_000_000_000,
        modelsDir: "/virtual/models",
        iniPath: "/virtual/ini/hexagon-models.ini",
        registryPath: "/virtual/registry/models-registry.json",
        configDir: "/virtual/config/kilo",
        workspaceDir: "/virtual/repo",
        sync,
      },
      sync,
      written,
    };
  }

  it("resolveBenchScript: usa script locale se presente, altrimenti fallback su bundled", () => {
    expect(resolveBenchScript({ workspaceDir: "/virtual/custom", exists: (p) => p.includes("custom") })).toContain(
      "benchmark-hexagon.ps1",
    );
    expect(resolveBenchScript({ workspaceDir: "/virtual/nonexistent", exists: () => false })).toBe(
      BUNDLED_BENCH_SCRIPT,
    );
  });

  it("hexagon_status: esecuzione e JSON formattato", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    expect(Object.keys(tools).sort()).toEqual([
      "hexagon_bench",
      "hexagon_models",
      "hexagon_qualify",
      "hexagon_restart",
      "hexagon_setup",
      "hexagon_status",
      "hexagon_sync",
    ]);
    const raw = await tools.hexagon_status.execute({}, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed.router.port).toBe(18803);
    expect(parsed.router.ready).toBe(true);
    expect(parsed.loadedModels).toEqual(["Ornith-1.5-9B-Q4_0"]);
    expect(raw).toContain("\n");
  });

  it("hexagon_models: lista modelli locali propagando CERTIFIED e INCOMPATIBLE da models-registry.json", async () => {
    const { deps, written } = makeDeps();
    written.set(
      "/virtual/registry/models-registry.json",
      JSON.stringify({
        "custom-cert": {
          modelId: "custom-cert",
          status: "certified",
          device: "HTP0,GPUOpenCL",
          tensorSplit: "80,20",
          contextWindow: 131_072,
          metrics: { prefillTokPerSec: 500, genTokPerSec: 42, device: "HTP0,GPUOpenCL" },
          timestamp: "2026-11-25T00:00:00Z",
        },
        "custom-bad": {
          modelId: "custom-bad",
          status: "incompatible",
          device: "HTP0",
          contextWindow: 16_384,
          error: "Crash 0x200",
          timestamp: "2026-11-25T00:00:00Z",
        },
      }),
    );
    const tools = createHexagonTools({
      ...deps,
      listDir: async () => [
        "Ornith-1.5-9B-Q4_0.gguf",
        "custom-cert.gguf",
        "custom-bad.gguf",
      ],
    });
    const raw = await tools.hexagon_models.execute({}, undefined as never);
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      status: string;
      device: string;
      tensorSplit?: string;
      error?: string;
    }>;
    expect(parsed.find((m) => m.id === "Ornith-1.5-9B-Q4_0")?.status).toBe("certified");
    expect(parsed.find((m) => m.id === "custom-cert")).toMatchObject({
      status: "certified",
      device: "HTP0,GPUOpenCL",
      tensorSplit: "80,20",
    });
    expect(parsed.find((m) => m.id === "custom-bad")).toMatchObject({
      status: "incompatible",
      error: "Crash 0x200",
    });
  });

  it("hexagon_qualify: qualifica un modello esistente e salva sul registry isolato", async () => {
    const { deps, written } = makeDeps();
    const tools = createHexagonTools({
      ...deps,
      listDir: async () => ["test-model.gguf"],
    });
    const raw = await tools.hexagon_qualify.execute({ model: "test-model" }, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed.modelId).toBe("test-model");
    expect(parsed.status).toBe("certified");
    expect(written.get("/virtual/registry/models-registry.json")).toContain("test-model");
  });

  it("hexagon_setup: allinea config workspace e globale in memoria senza toccare disco", async () => {
    const { deps, written } = makeDeps();
    const tools = createHexagonTools(deps);

    const wsRaw = await tools.hexagon_setup.execute({ workspace: true }, undefined as never);
    const wsParsed = JSON.parse(wsRaw);
    expect(wsParsed.updated).toBe(true);
    expect(wsParsed.modelCount).toBeGreaterThan(0);
    expect(written.has(wsParsed.targetPath)).toBe(true);

    const globalRaw = await tools.hexagon_setup.execute({ workspace: false }, undefined as never);
    const globalParsed = JSON.parse(globalRaw);
    expect(globalParsed.updated).toBe(true);
    expect(globalParsed.targetPath).toContain("kilo.jsonc");
    expect(written.has(globalParsed.targetPath)).toBe(true);
  });

  it("hexagon_sync: sincronizza catalogo, gestisce reload stale e catch sicuri", async () => {
    const { deps, sync } = makeDeps();
    const tools = createHexagonTools(deps);
    const parsed = JSON.parse(
      await tools.hexagon_sync.execute({}, undefined as never),
    );
    expect(sync).toHaveBeenCalledWith({ force: true });
    expect(parsed.updated).toBe(true);
    expect(parsed.message).toBe("allineato");
    expect(parsed.catalog.routerReloaded).toBe(false);

    // Senza writeFile/listDir/exists/spawn e con waitForHealth fallito (catch sicuro)
    const toolsMinimal = createHexagonTools({
      fetch: async () => {
        throw new Error("down");
      },
      exec: deps.exec,
      readFile: deps.readFile,
      sleep: async () => {},
      workspaceDir: deps.workspaceDir,
      sync,
    });
    const minParsed = JSON.parse(
      await toolsMinimal.hexagon_sync.execute({}, undefined as never),
    );
    expect(minParsed.health).toBeUndefined();
    expect(minParsed.catalog.iniUpdated).toBe(false);

    // Senza spawn ma con writeFile/listDir/exists
    const toolsNoSpawn = createHexagonTools({
      ...deps,
      spawn: undefined,
    });
    const noSpawnParsed = JSON.parse(
      await toolsNoSpawn.hexagon_sync.execute({}, undefined as never),
    );
    expect(noSpawnParsed.catalog.routerReloaded).toBe(false);

    // sync.updated=false ma routerReloaded=true quando il router era spento
    let spawnedForReload = false;
    const reloadTools = createHexagonTools({
      ...deps,
      sync: async () => ({ ...syncOutcome, updated: false }),
      fetch: async (url: string) => {
        if (!spawnedForReload) throw new Error("ECONNREFUSED");
        return url.endsWith("/health")
          ? fakeResponse(200, { status: "ok" })
          : fakeResponse(200, { object: "list", data: [] });
      },
      spawn: (...args) => {
        spawnedForReload = true;
        return deps.spawn(...args);
      },
    });
    const reloadedParsed = JSON.parse(
      await reloadTools.hexagon_sync.execute({}, undefined as never),
    );
    expect(reloadedParsed.catalog.routerReloaded).toBe(true);
    expect(reloadedParsed.health.ready).toBe(true);

    // Con errore in listDir durante syncDiscoveredModelsToIni, spawn fallito e sync.updated=false
    const toolsErr = createHexagonTools({
      ...deps,
      sync: async () => ({ ...syncOutcome, updated: false }),
      listDir: async () => {
        throw new Error("listDir error");
      },
      fetch: async () => {
        throw new Error("network error");
      },
      spawn: () => {
        throw new Error("spawn error");
      },
    });
    const errParsed = JSON.parse(
      await toolsErr.hexagon_sync.execute({}, undefined as never),
    );
    expect(errParsed.catalog.iniUpdated).toBe(false);
    expect(errParsed.catalog.routerReloaded).toBe(false);
    expect(errParsed.health).toBeUndefined();

    // Con ignoreServerErrors e reloadServerIfStale che fallisce dopo ensureServer ok
    const reloadErrTools = createHexagonTools({
      ...deps,
      sync: async () => ({ ...syncOutcome, updated: false }),
      fetch: async (url) =>
        url.endsWith("/v1/models")
          ? fakeResponse(200, { object: "list", data: [] })
          : routerResponse(url),
      readFile: async () => {
        throw new Error("read boom");
      },
      listDir: async () => [],
      exists: async (p) => p.endsWith("hexagon-models.ini"),
    });
    const reloadErrParsed = JSON.parse(
      await reloadErrTools.hexagon_sync.execute({}, undefined as never),
    );
    expect(reloadErrParsed.catalog.routerReloaded).toBe(false);

    // Con ignoreServerErrors=true e reloadServerIfStale riuscito ma health post-reload fallito
    let postReloadDown = false;
    const defaultServerExe = defaultPaths(deps.workspaceDir).serverExe;
    const routerProc = [
      {
        ProcessId: 6601,
        ParentProcessId: 1,
        ExecutablePath: defaultServerExe,
        CommandLine:
          `"${defaultServerExe}" --host 127.0.0.1 --port 18803 --models-dir /virtual/models --models-preset /virtual/ini/hexagon-models.ini`,
      },
    ];
    const postReloadHealthFailTools = createHexagonTools({
      ...deps,
      sync: async () => ({ ...syncOutcome, updated: false }),
      exec: async (cmd, args) => {
        if (cmd === "powershell" && args.some((a) => a.includes("Win32_Process"))) {
          return okExec(JSON.stringify(routerProc));
        }
        if (cmd === "ps") {
          return okExec(
            `6601 1 "${defaultServerExe}" --host 127.0.0.1 --port 18803 --models-dir /virtual/models --models-preset /virtual/ini/hexagon-models.ini`,
          );
        }
        return okExec("");
      },
      fetch: async (url) => {
        if (postReloadDown) throw new Error("down after reload");
        if (url.endsWith("/v1/models")) {
          return fakeResponse(200, { object: "list", data: [] });
        }
        return routerResponse(url);
      },
      spawn: (...args) => {
        postReloadDown = true;
        return deps.spawn(...args);
      },
    });
    const postReloadParsed = JSON.parse(
      await postReloadHealthFailTools.hexagon_sync.execute({}, undefined as never),
    );
    expect(postReloadParsed.catalog.routerReloaded).toBe(true);
    expect(postReloadParsed.health).toBeUndefined();
  });

  it("hexagon_bench: token/s nel JSON e forwarding -Device/-TensorSplit", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec());
    const { deps } = makeDeps();
    const tools = createHexagonTools({ ...deps, exec });
    const parsed = JSON.parse(
      await tools.hexagon_bench.execute(
        {
          model: "Ornith-1.5-9B-Q4_0",
          device: "HTP0,GPUOpenCL",
          tensorSplit: "75,25",
        },
        undefined as never,
      ),
    );
    expect(parsed.results[0].tokPerSec).toBe(750.5);
    expect(parsed.results[0].npuW).toBe(14.2);
    expect(parsed.results[0].socW).toBe(21.9);
    expect(parsed.model).toBe("Ornith-1.5-9B-Q4_0");
    expect(calls[0].args).toContain("-Device");
    expect(calls[0].args[calls[0].args.indexOf("-Device") + 1]).toBe("HTP0,GPUOpenCL");
    expect(calls[0].args).toContain("-TensorSplit");
    expect(calls[0].args[calls[0].args.indexOf("-TensorSplit") + 1]).toBe("75,25");
  });

  it("hexagon_qualify: errore se modello non esiste", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    const raw = await tools.hexagon_qualify.execute({ model: "non-esistente" }, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("error");
    expect(parsed.error).toContain("non-esistente");
  });

  it("hexagon_qualify: qualifica modello certificato per nome file .gguf", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools({
      ...deps,
      iniPath: undefined,
    });
    const raw = await tools.hexagon_qualify.execute({ model: "Ornith-1.5-9B-Q4_0.gguf" }, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed.modelId).toBe("Ornith-1.5-9B-Q4_0");
    expect(parsed.status).toBe("certified");

    const setupDefaultIni = createHexagonTools({
      ...deps,
      iniPath: undefined,
    });
    const setupParsed = JSON.parse(
      await setupDefaultIni.hexagon_setup.execute({ workspace: true }, undefined as never),
    );
    expect(setupParsed.updated).toBe(true);
  });

  it("hexagon_status include runtime checkRuntime quando fornito e espone offload reale e warm-up da log", async () => {
    const { deps } = makeDeps();
    const serverLog = [
      "ggml-hex: Hexagon Arch version v81, DMA64 enabled",
      "srv loading model 'Ornith-1.5-9B-Q4_0'",
      "load_tensors: offloaded 36/36 layers to GPU",
      "load_tensors: HTP0 model buffer size = 5100.00 MiB",
      "llama_perf_context_print: load time = 1350.00 ms",
      "llama_perf_context_print: eval time = 1000.00 ms / 45 runs (22.22 ms per token, 45.00 tokens per second)",
    ].join("\n");
    const tools = createHexagonTools({
      ...deps,
      logPath: "/virtual/logs/llama-server.log",
      logsDir: "/virtual/logs",
      exists: async (p) => p === "/virtual/logs/llama-server.log",
      readFile: async (p) => (p === "/virtual/logs/llama-server.log" ? serverLog : ""),
      checkRuntime: async () => ({
        geniexHash: "93cf736",
        llamaCommit: "93cf736",
        commitAligned: true,
        missingFiles: [],
        staleFiles: ["ggml-hexagon.dll"],
        needsSync: true,
      }),
    });
    const parsed = JSON.parse(await tools.hexagon_status.execute({}, undefined as never));
    expect(parsed.runtime.needsSync).toBe(true);
    expect(parsed.runtime.staleFiles).toEqual(["ggml-hexagon.dll"]);
    expect(parsed.offload[0].offloadPercent).toBe(100);
    expect(parsed.warmUp.htpWarmUpMs).toBe(1350);
    expect(parsed.throughput.evalTokPerSec).toBe(45);

    const toolsErr = createHexagonTools({
      ...deps,
      checkRuntime: async () => {
        throw new Error("check fallito");
      },
    });
    const parsedErr = JSON.parse(await toolsErr.hexagon_status.execute({}, undefined as never));
    expect(parsedErr.runtime.error).toContain("check fallito");

    const toolsStrErr = createHexagonTools({
      ...deps,
      checkRuntime: async () => {
        throw "raw-check-failure";
      },
    });
    const parsedStrErr = JSON.parse(await toolsStrErr.hexagon_status.execute({}, undefined as never));
    expect(parsedStrErr.runtime.error).toBe("raw-check-failure");
  });

  it("hexagon_restart: arresta, riavvia e restituisce stato health/modelli", async () => {
    let killed = false;
    let spawned = false;
    const { fn: fetch } = recordingFetch((call) => {
      if (killed && !spawned) throw new Error("ECONNREFUSED");
      return call.url.endsWith("/v1/models")
        ? fakeResponse(200, { data: [{ id: "Ornith-1.5-9B-Q4_0" }] })
        : fakeResponse(200, { status: "ok" });
    });
    const { fn: exec } = recordingExec(() => {
      killed = true;
      return okExec("");
    });
    const { fn: spawn } = recordingSpawn(5555);
    const { deps } = makeDeps();
    const tools = createHexagonTools({
      ...deps,
      fetch,
      exec,
      sleep: async () => {},
      spawn: (...args) => {
        spawned = true;
        return spawn(...args);
      },
    });
    const parsed = JSON.parse(await tools.hexagon_restart.execute({}, undefined as never));
    expect(parsed.restarted).toBe(true);
    expect(parsed.health.ready).toBe(true);
    expect(parsed.loadedModels).toEqual(["Ornith-1.5-9B-Q4_0"]);

    // Default iniPath e modelsDir in hexagon_restart (usati solo come argomenti spawn mockati)
    const toolsDefaults = createHexagonTools({
      ...deps,
      iniPath: undefined,
      modelsDir: undefined,
      fetch,
      exec,
      sleep: async () => {},
      spawn: (...args) => {
        spawned = true;
        return spawn(...args);
      },
    });
    killed = false;
    spawned = false;
    const parsedDefaults = JSON.parse(await toolsDefaults.hexagon_restart.execute({}, undefined as never));
    expect(parsedDefaults.restarted).toBe(true);

    const toolsMinimalDefaults = createHexagonTools({
      fetch,
      exec: async () => okExec(),
      readFile: async () => "",
      workspaceDir: "/virtual/nonexistent-ws-for-tools",
      modelsDir: "/virtual/nonexistent-models-dir",
      sync: async () => syncOutcome,
    });
    expect(JSON.parse(await toolsMinimalDefaults.hexagon_models.execute({}, undefined as never))).toEqual([]);
    const qualMissing = JSON.parse(
      await toolsMinimalDefaults.hexagon_qualify.execute({ model: "absent" }, undefined as never),
    );
    expect(qualMissing.error).toContain("non trovato");

    // Default modelsDir da defaultPaths quando omesso (exists=false evita letture su disco)
    const toolsDefaultModelsDir = createHexagonTools({
      fetch,
      exec: async () => okExec(),
      readFile: async () => "",
      exists: async () => false,
      workspaceDir: "/virtual/nonexistent-ws-for-tools",
      sync: async () => syncOutcome,
    });
    expect(JSON.parse(await toolsDefaultModelsDir.hexagon_models.execute({}, undefined as never))).toEqual([]);
    const qualDefaultMissing = JSON.parse(
      await toolsDefaultModelsDir.hexagon_qualify.execute({ model: "absent" }, undefined as never),
    );
    expect(qualDefaultMissing.error).toContain("non trovato");

    // Copre default iniPath, listDir fallback su bootstrap (no listDir) e ignoreIniErrors
    const toolsNoIniPath = createHexagonTools({
      fetch,
      exec: async () => okExec(),
      readFile: async () => "",
      writeFile: async () => {},
      exists: async () => false,
      spawn: (...args) => deps.spawn(...args),
      sleep: async () => {},
      workspaceDir: "/virtual/nonexistent-ws-for-tools",
      modelsDir: "/virtual/nonexistent-models-dir",
      sync: async () => ({ ...syncOutcome, updated: false }),
    });
    const noIniSync = JSON.parse(await toolsNoIniPath.hexagon_sync.execute({}, undefined as never));
    expect(noIniSync.catalog.iniUpdated).toBe(false);
  });

  it("descrizioni dei tool presenti", () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    expect(tools.hexagon_status.description).toContain("Snapdragon");
    expect(tools.hexagon_sync.description).toContain("riallineamento atomico");
    expect(tools.hexagon_restart.description).toContain("riavvia");
    expect(tools.hexagon_bench.description).toContain("token/s");
    expect(tools.hexagon_setup.description).toContain("kilo.json");
    expect(tools.hexagon_models.description).toContain("Elenca tutti i modelli GGUF");
    expect(tools.hexagon_qualify.description).toContain("Qualification Gate");
  });
});
