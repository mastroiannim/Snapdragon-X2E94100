import { describe, expect, it, vi } from "vitest";
import {
  collectStatus,
  createHexagonTools,
  parseBenchReport,
  parseOptionalNumber,
  resolveBenchScript,
  runBenchmark,
} from "../src/tools.js";
import { BUNDLED_BENCH_SCRIPT } from "../src/process.js";
import type { SyncOutcome } from "../src/sync.js";
import { fakeResponse, okExec, recordingExec, recordingFetch } from "./helpers.js";

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
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:18803/health",
      "http://127.0.0.1:18803/v1/models",
    ]);
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
  const workspace = "C:/repo";

  it("lancia benchmark-hexagon.ps1 e legge il report", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec("=== RISULTATI ==="));
    const readFile = vi.fn(async () => BENCH_MARKDOWN);
    const report = await runBenchmark({
      exec,
      readFile,
      workspaceDir: workspace,
      model: "Ornith-1.5-9B-Q4_0",
      reportPath: "C:/tmp/bench.md",
    });
    expect(report.model).toBe("Ornith-1.5-9B-Q4_0");
    expect(report.results).toHaveLength(3);
    expect(report.reportPath).toBe("C:/tmp/bench.md");
    const call = calls[0];
    expect(call.command).toBe("powershell");
    expect(call.args[call.args.indexOf("-File") + 1]).toBe(BUNDLED_BENCH_SCRIPT);
    expect(call.args[call.args.indexOf("-Models") + 1]).toBe(
      "Ornith-1.5-9B-Q4_0.gguf",
    );
    expect(call.args[call.args.indexOf("-Repetitions") + 1]).toBe("1");
    expect(readFile).toHaveBeenCalledWith("C:/tmp/bench.md");
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
    });
    const args = calls[0].args;
    expect(args[args.indexOf("-Models") + 1]).toBe("x.gguf");
    expect(args[args.indexOf("-Repetitions") + 1]).toBe("3");
  });

  it("senza modello: suite predefinita, report temporaneo", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec());
    const readFile = vi.fn(async () => "");
    const report = await runBenchmark({ exec, readFile, workspaceDir: workspace });
    expect(calls[0].args).not.toContain("-Models");
    expect(report.model).toBe("suite predefinita");
    expect(report.reportPath).toContain("hexagon-bench-");
  });

  it("exit non-zero: errore propagato", async () => {
    const { fn: exec } = recordingExec(() => ({
      code: 2,
      stdout: "",
      stderr: "modello mancante",
    }));
    const readFile = vi.fn(async () => "");
    await expect(
      runBenchmark({ exec, readFile, workspaceDir: workspace, reportPath: "r.md" }),
    ).rejects.toThrow(/benchmark-hexagon\.ps1 fallito \(exit 2\).*modello mancante/);
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
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/health")
        ? fakeResponse(200)
        : fakeResponse(200, { data: [{ id: "Ornith-1.5-9B-Q4_0" }] }),
    );
    const { fn: exec } = recordingExec(() => okExec());
    const readFile = vi.fn(async () => BENCH_MARKDOWN);
    const sync = vi.fn(async () => syncOutcome);
    return {
      deps: { fetch, exec, readFile, workspaceDir: "C:/repo", sync },
      sync,
    };
  }

  it("resolveBenchScript: usa script locale se presente, altrimenti fallback su bundled", () => {
    expect(resolveBenchScript({ workspaceDir: "C:/custom", exists: (p) => p.includes("custom") })).toBe(
      "C:\\custom\\benchmark-hexagon.ps1",
    );
    expect(resolveBenchScript({ workspaceDir: "C:/nonexistent", exists: () => false })).toBe(
      BUNDLED_BENCH_SCRIPT,
    );
  });

  it("hexagon_status: esecuzione e JSON formattato", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    expect(Object.keys(tools)).toEqual([
      "hexagon_status",
      "hexagon_sync",
      "hexagon_bench",
      "hexagon_setup",
    ]);
    const raw = await tools.hexagon_status.execute({}, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed.router.port).toBe(18803);
    expect(parsed.router.ready).toBe(true);
    expect(parsed.loadedModels).toEqual(["Ornith-1.5-9B-Q4_0"]);
    expect(raw).toContain("\n");
  });

  it("hexagon_setup: esecuzione e allineamento config", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    const raw = await tools.hexagon_setup.execute({ workspace: true }, undefined as never);
    const parsed = JSON.parse(raw);
    expect(parsed.updated).toBe(true);
    expect(parsed.modelCount).toBeGreaterThan(0);
  });

  it("hexagon_sync: trigger force e JSON dell'esito", async () => {
    const { deps, sync } = makeDeps();
    const tools = createHexagonTools(deps);
    const parsed = JSON.parse(
      await tools.hexagon_sync.execute({}, undefined as never),
    );
    expect(sync).toHaveBeenCalledWith({ force: true });
    expect(parsed.updated).toBe(true);
    expect(parsed.message).toBe("allineato");
  });

  it("hexagon_bench: token/s nel JSON", async () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    const parsed = JSON.parse(
      await tools.hexagon_bench.execute(
        { model: "Ornith-1.5-9B-Q4_0" },
        undefined as never,
      ),
    );
    expect(parsed.results[0].tokPerSec).toBe(750.5);
    expect(parsed.results[0].npuW).toBe(14.2);
    expect(parsed.results[0].socW).toBe(21.9);
    expect(parsed.model).toBe("Ornith-1.5-9B-Q4_0");
  });

  it("descrizioni dei tool presenti", () => {
    const { deps } = makeDeps();
    const tools = createHexagonTools(deps);
    expect(tools.hexagon_status.description).toContain("Snapdragon");
    expect(tools.hexagon_sync.description).toContain("sync-geniex");
    expect(tools.hexagon_bench.description).toContain("token/s");
    expect(tools.hexagon_setup.description).toContain("kilo.json");
  });
});
