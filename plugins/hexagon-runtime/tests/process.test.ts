import { describe, expect, it, vi } from "vitest";
import {
  buildDirectArgs,
  buildRouterArgs,
  defaultPaths,
  ensureModelsIni,
  ensureServer,
  isServerActive,
  parseJsonPayload,
  parseModelsIni,
  probeRouter,
  ROUTER_HOST,
  ROUTER_PORT,
  serverEnv,
} from "../src/process.js";
import {
  fakeResponse,
  okExec,
  recordingExec,
  recordingFetch,
  recordingSpawn,
  recordingWriteFile,
  routerResponse,
} from "./helpers.js";

const INI_SAMPLE = `version = 1
# commento
[*]
flash-attn = on
n-gpu-layers = 999
threads = 12
batch-size = 4096

; altro commento
[Ornith-1.5-9B-Q4_0]
model = C:/models/Ornith-1.5-9B-Q4_0.gguf
device = HTP0
ctx-size = 65536

[gpt-oss-20b-Q4_0]
model = C:/models/gpt-oss-20b-Q4_0.gguf
device = HTP0,GPUOpenCL
tensor-split = 80,20
ctx-size = 131072
custom-flag = valore
`;

describe("parseModelsIni", () => {
  it("legge default globali [*] e sezioni modello", () => {
    const ini = parseModelsIni(INI_SAMPLE);
    expect(ini.globals["flash-attn"]).toBe("on");
    expect(ini.globals["n-gpu-layers"]).toBe("999");
    expect(ini.models["Ornith-1.5-9B-Q4_0"]).toMatchObject({
      name: "Ornith-1.5-9B-Q4_0",
      model: "C:/models/Ornith-1.5-9B-Q4_0.gguf",
      device: "HTP0",
      ctxSize: 65536,
    });
    expect(ini.models["gpt-oss-20b-Q4_0"].tensorSplit).toBe("80,20");
    expect(ini.models["gpt-oss-20b-Q4_0"].ctxSize).toBe(131072);
  });

  it("preserva i flag non interpretati e ignora righe invalide", () => {
    const ini = parseModelsIni(
      "chiave senza sezione = x\n[r]\nmodel = m.gguf\nriga senza uguale\nctx-size = non-numerico\n",
    );
    expect(ini.models["r"].flags).toEqual({});
    expect(ini.models["r"].ctxSize).toBeUndefined();
    expect(ini.globals).toEqual({});
  });

  it("INI vuoto: nessun modello", () => {
    expect(parseModelsIni("").models).toEqual({});
  });
});

describe("buildRouterArgs", () => {
  it("default: router 127.0.0.1:18803 con preset INI", () => {
    const args = buildRouterArgs({ iniPath: "C:/repo/hexagon-models.ini", modelsDir: "C:/models" });
    expect(args).toEqual([
      "--host", "127.0.0.1",
      "--port", "18803",
      "--jinja", "--agent", "-lv", "3",
      "--models-dir", "C:/models",
      "--models-preset", "C:/repo/hexagon-models.ini",
      "--models-max", "2",
    ]);
  });

  it("override di porta, host e models-max", () => {
    const args = buildRouterArgs({
      iniPath: "i", modelsDir: "m", port: 19000, host: "0.0.0.0", modelsMax: 4,
    });
    expect(args[args.indexOf("--port") + 1]).toBe("19000");
    expect(args[args.indexOf("--host") + 1]).toBe("0.0.0.0");
    expect(args[args.indexOf("--models-max") + 1]).toBe("4");
  });
});

describe("buildDirectArgs", () => {
  const ini = parseModelsIni(INI_SAMPLE);

  it("modello NPU: context 65536 e device HTP0", () => {
    const args = buildDirectArgs(ini.models["Ornith-1.5-9B-Q4_0"], ini.globals);
    expect(args[args.indexOf("-c") + 1]).toBe("65536");
    expect(args[args.indexOf("-dev") + 1]).toBe("HTP0");
    expect(args).not.toContain("-ts");
    expect(args[args.indexOf("-m") + 1]).toBe("C:/models/Ornith-1.5-9B-Q4_0.gguf");
    expect(args[args.indexOf("--alias") + 1]).toBe("Ornith-1.5-9B-Q4_0");
    expect(args[args.indexOf("-ngl") + 1]).toBe("999");
    expect(args[args.indexOf("-fa") + 1]).toBe("on");
    expect(args[args.indexOf("-b") + 1]).toBe("4096");
    expect(args).toContain("--context-shift");
  });

  it("modello ibrido: tensor-split 80,20 e context 131072", () => {
    const args = buildDirectArgs(ini.models["gpt-oss-20b-Q4_0"], ini.globals);
    expect(args[args.indexOf("-ts") + 1]).toBe("80,20");
    expect(args[args.indexOf("-dev") + 1]).toBe("HTP0,GPUOpenCL");
    expect(args[args.indexOf("-c") + 1]).toBe("131072");
  });

  it("default senza globals: ctx 65536, mlock, threads 12", () => {
    const args = buildDirectArgs({
      name: "x", model: "x.gguf", device: "HTP0", flags: {},
    });
    expect(args[args.indexOf("-c") + 1]).toBe("65536");
    expect(args[args.indexOf("-lm") + 1]).toBe("mlock");
    expect(args[args.indexOf("-t") + 1]).toBe("12");
    expect(args[args.indexOf("--port") + 1]).toBe("18803");
  });
});

describe("serverEnv", () => {
  it("ADSP_LIBRARY_PATH punta tassativamente alla directory runtime", () => {
    const env = serverEnv("C:/bin", { PATH: "C:/windows", TEMP: "C:/tmp" });
    expect(env.ADSP_LIBRARY_PATH).toBe("C:/bin");
    expect(env.GGML_HEXAGON_OPBATCH).toBe("512");
    expect(env.GGML_HEXAGON_VTCM_SIZE).toBe("8M");
    expect(env.PATH).toBe("C:/windows");
    expect(env.TEMP).toBe("C:/tmp");
  });

  it("sovrascrive un ADSP_LIBRARY_PATH esistente", () => {
    const env = serverEnv("C:/bin", { ADSP_LIBRARY_PATH: "C:/vecchio" });
    expect(env.ADSP_LIBRARY_PATH).toBe("C:/bin");
  });
});

describe("isServerActive", () => {
  it("risposta HTTP (anche 503 in warm-up): processo in ascolto", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(503));
    expect(await isServerActive({ fetch })).toBe(true);
  });

  it("connessione rifiutata: server non attivo", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await isServerActive({ fetch })).toBe(false);
  });

  it("timeout della sonda: nessun blocco indefinito", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    expect(await isServerActive({ fetch, timeoutMs: 20 })).toBe(false);
  });

  it("usa host e porta override", async () => {
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
    await isServerActive({ fetch, host: "127.0.0.2", port: 19999 });
    expect(calls[0].url).toBe("http://127.0.0.2:19999/health");
  });
});

describe("ensureServer", () => {
  const base = {
    runtimeDir: "C:/bin",
    serverExe: "C:/bin/llama-server.exe",
    iniPath: "C:/repo/hexagon-models.ini",
    modelsDir: "C:/models",
  };

  it("server gia' attivo e identificato: isolamento, nessuna spawn", async () => {
    const { fn: fetch } = recordingFetch((call) => routerResponse(call.url));
    const { fn: spawn, calls } = recordingSpawn();
    const result = await ensureServer({ ...base, fetch, spawn });
    expect(result.started).toBe(false);
    expect(result.pid).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("processo estraneo sulla porta: avvio rifiutato, nessuna interferenza", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(200, { hello: "world" }));
    const { fn: spawn, calls } = recordingSpawn();
    await expect(ensureServer({ ...base, fetch, spawn })).rejects.toThrow(
      /non identificato come llama-server/,
    );
    expect(calls).toHaveLength(0);
  });

  it("server assente: avvio con ADSP_LIBRARY_PATH e argomenti router", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const { fn: spawn, calls } = recordingSpawn(1234);
    const result = await ensureServer({ ...base, fetch, spawn });
    expect(result.started).toBe(true);
    expect(result.pid).toBe(1234);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe(base.serverExe);
    expect(call.options?.cwd).toBe(base.runtimeDir);
    expect(call.options?.detached).toBe(true);
    expect(call.options?.env?.ADSP_LIBRARY_PATH).toBe(base.runtimeDir);
    expect(call.args[call.args.indexOf("--port") + 1]).toBe("18803");
    expect(call.args[call.args.indexOf("--models-preset") + 1]).toBe(base.iniPath);
  });

  it("pid undefined dal subsystem: started comunque true", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("down");
    });
    const { fn: spawn } = recordingSpawn(undefined);
    const result = await ensureServer({ ...base, fetch, spawn });
    expect(result.started).toBe(true);
    expect(result.pid).toBeUndefined();
  });
});

describe("defaultPaths", () => {
  it("percorsi standard Windows ARM64", () => {
    const paths = defaultPaths("C:/repo", "C:/Users/test", "C:/Users/test/AppData/Local");
    expect(paths.binPath).toBe("C:\\Users\\test\\llama-cpp\\llama-bin-win-cpu-arm64");
    expect(paths.geniexDir).toBe("C:\\Users\\test\\AppData\\Local\\GenieX CLI");
    expect(paths.geniexExe).toContain("geniex.exe");
    expect(paths.serverExe).toContain("llama-server.exe");
    expect(paths.modelsDir).toBe("C:\\Users\\test\\.cache\\geniex\\models");
    expect(paths.iniPath).toBe("C:\\repo\\hexagon-models.ini");
  });

  it("default da homedir/LOCALAPPDATA reali", () => {
    const paths = defaultPaths("C:/repo");
    expect(paths.workspaceDir).toBe("C:/repo");
    expect(paths.binPath).toContain("llama-bin-win-cpu-arm64");
    expect(paths.geniexDir).toContain("GenieX CLI");
  });

  it("LOCALAPPDATA assente: fallback su AppData/Local sotto homedir", () => {
    const saved = process.env.LOCALAPPDATA;
    delete process.env.LOCALAPPDATA;
    try {
      const paths = defaultPaths("C:/repo", "C:/Users/test");
      expect(paths.geniexDir).toBe(
        "C:\\Users\\test\\AppData\\Local\\GenieX CLI",
      );
    } finally {
      if (saved !== undefined) process.env.LOCALAPPDATA = saved;
    }
  });

  it("costanti router", () => {
    expect(ROUTER_PORT).toBe(18803);
    expect(ROUTER_HOST).toBe("127.0.0.1");
  });
});

describe("probeRouter: verifica d'identita'", () => {
  it("shape OpenAI di /v1/models: identificato", async () => {
    const { fn: fetch, calls } = recordingFetch((call) =>
      call.url.endsWith("/v1/models")
        ? fakeResponse(200, { object: "list", data: [{ id: "m" }] })
        : fakeResponse(503),
    );
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: true });
    expect(calls).toHaveLength(1);
  });

  it("data array senza object: identificato", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(200, { data: [] }));
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: true });
  });

  it("/v1/models non-ok ma /health con status: identificato via fallback", async () => {
    const { fn: fetch, calls } = recordingFetch((call) =>
      call.url.endsWith("/health")
        ? fakeResponse(503, { status: "loading model" })
        : fakeResponse(503),
    );
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: true });
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:18803/v1/models",
      "http://127.0.0.1:18803/health",
    ]);
  });

  it("risposte senza shape llama-server: in ascolto ma non identificato", async () => {
    const { fn: fetch } = recordingFetch(() => fakeResponse(200, { hello: "world" }));
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: false });
  });

  it("json non valido su /health: non identificato", async () => {
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/health")
        ? { status: 200, ok: true, json: async () => { throw new Error("bad json"); }, text: async () => "" }
        : fakeResponse(404),
    );
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: false });
  });

  it("nessuna risposta: porta libera", async () => {
    const { fn: fetch } = recordingFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeRouter({ fetch })).toEqual({ listening: false, identified: false });
  });

  it("/v1/models muto ma /health vivo: listening preservato", async () => {
    const { fn: fetch } = recordingFetch((call) => {
      if (call.url.endsWith("/v1/models")) throw new Error("ECONNRESET");
      return fakeResponse(200, { status: "ok" });
    });
    expect(await probeRouter({ fetch })).toEqual({ listening: true, identified: true });
  });

  it("timeout della sonda: nessun blocco indefinito", async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    expect(await probeRouter({ fetch, timeoutMs: 20 })).toEqual({
      listening: false,
      identified: false,
    });
  });
});

describe("parseJsonPayload", () => {
  it("JSON puro", () => {
    expect(parseJsonPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("JSON multi-riga con diagnostica prima e dopo", () => {
    const stdout = 'WARNING: avviso\n{\n  "mode": "Router",\n  "ini_content": "x"\n}\nfine';
    expect(parseJsonPayload(stdout)).toEqual({ mode: "Router", ini_content: "x" });
  });

  it("output vuoto o senza graffe: errore", () => {
    expect(() => parseJsonPayload("   ")).toThrow(/output vuoto/);
    expect(() => parseJsonPayload("testo libero")).toThrow(/payload JSON non trovato/);
  });
});

describe("ensureModelsIni: zero-setup INI", () => {
  const base = { iniPath: "C:/repo/hexagon-models.ini", workspaceDir: "C:/repo" };
  const iniContent = "[*]\nthreads = 12\n\n[m]\nmodel = m.gguf\ndevice = HTP0\nctx-size = 65536\n";

  it("INI presente: nessuna generazione", async () => {
    const { fn: exec, calls } = recordingExec(() => okExec());
    const { fn: writeFile, calls: writes } = recordingWriteFile();
    const result = await ensureModelsIni({
      ...base,
      exec,
      exists: async () => true,
      writeFile,
    });
    expect(result).toEqual({ generated: false, modelCount: 0 });
    expect(calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it("INI assente: preview DryRun del launcher e scrittura di ini_content", async () => {
    const { fn: exec, calls } = recordingExec(() =>
      okExec(JSON.stringify({ mode: "Router", ini_content: iniContent, models: [{}, {}] }, null, 2)),
    );
    const { fn: writeFile, calls: writes } = recordingWriteFile();
    const result = await ensureModelsIni({
      ...base,
      exec,
      exists: async () => false,
      writeFile,
    });
    expect(result).toEqual({ generated: true, modelCount: 2 });
    expect(writes).toEqual([{ path: base.iniPath, content: iniContent }]);
    const args = calls[0].args;
    expect(args[args.indexOf("-File") + 1]).toBe("C:\\repo\\launch-hexagon.ps1");
    expect(args).toContain("-DryRun");
    expect(args).toContain("-Json");
    expect(args[args.indexOf("-Mode") + 1]).toBe("Router");
  });

  it("launcher fallito: errore descrittivo", async () => {
    const { fn: exec } = recordingExec(() => ({ code: 1, stdout: "", stderr: "cache modelli vuota" }));
    const { fn: writeFile } = recordingWriteFile();
    await expect(
      ensureModelsIni({ ...base, exec, exists: async () => false, writeFile }),
    ).rejects.toThrow(/Generazione hexagon-models\.ini fallita.*cache modelli vuota/);
  });

  it("ini_content assente o vuoto: errore esplicito", async () => {
    const { fn: exec } = recordingExec(() => okExec('{"mode":"Router","models":[]}'));
    const { fn: writeFile } = recordingWriteFile();
    await expect(
      ensureModelsIni({ ...base, exec, exists: async () => false, writeFile }),
    ).rejects.toThrow(/ini_content assente/);
  });

  it("models non array: modelCount 0 ma generazione valida", async () => {
    const { fn: exec } = recordingExec(() => okExec(JSON.stringify({ ini_content: iniContent })));
    const { fn: writeFile } = recordingWriteFile();
    const result = await ensureModelsIni({
      ...base,
      exec,
      exists: async () => false,
      writeFile,
    });
    expect(result).toEqual({ generated: true, modelCount: 0 });
  });
});
