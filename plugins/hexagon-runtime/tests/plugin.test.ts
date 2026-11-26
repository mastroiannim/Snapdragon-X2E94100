import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Hooks, PluginInput } from "@kilocode/plugin";
import pluginInit, {
  bootstrapRuntime,
  createHexagonHooks,
  plugin,
} from "../src/index.js";
import { defaultPaths } from "../src/process.js";
import type { WatchdogOptions } from "../src/watchdog.js";
import type { ModelWatcherOptions } from "../src/watcher.js";
import type { SpawnFn } from "../src/types.js";
import {
  ALL_RUNTIME_FILES,
  GENIEX_VERSION_OUTPUT,
  LLAMA_VERSION_OUTPUT,
  okExec,
  recordingExec,
  recordingFetch,
  recordingSpawn,
  recordingWriteFile,
  routerResponse,
} from "./helpers.js";

type EventInput = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];
type ConfigInput = Parameters<NonNullable<Hooks["config"]>>[0];

function fakePluginInput(overrides: Partial<PluginInput> = {}): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: "/virtual/repo/dir",
    worktree: "/virtual/repo",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"],
    ...overrides,
  };
}

function chatIO(providerID: string) {
  const input = {
    sessionID: "s1",
    agent: "build",
    model: { providerID, modelID: "Ornith-1.5-9B-Q4_0" },
    provider: { source: "config", info: {}, options: {} },
    message: {},
  } as unknown as ChatParamsInput;
  const output: ChatParamsOutput = {
    temperature: 0.7,
    topP: 1,
    topK: 0,
    options: {},
  };
  return { input, output };
}

describe("descrittore e ingresso del plugin", () => {
  it("espone { id: hexagon-runtime, server } come export nominale", () => {
    expect(plugin.id).toBe("hexagon-runtime");
    expect(plugin.server).toBe(pluginInit);
  });

  it("pluginInit ritorna gli hook con i sette tool agent", async () => {
    const hooks = await pluginInit(fakePluginInput());
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "hexagon_bench",
      "hexagon_models",
      "hexagon_qualify",
      "hexagon_restart",
      "hexagon_setup",
      "hexagon_status",
      "hexagon_sync",
    ]);
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.config).toBe("function");
  });

  it("worktree e directory vuoti: fallback su process.cwd()", async () => {
    const hooks = await pluginInit(fakePluginInput({ worktree: "", directory: "" }));
    expect(hooks.tool).toBeDefined();
  });
});

describe("hook chat.params", () => {
  it("modello locale: reasoning_effort none per tool-calling deterministico", async () => {
    const hooks = createHexagonHooks({ workspaceDir: "/virtual/repo" });
    const { input, output } = chatIO("hexagon");
    await hooks["chat.params"]!(input, output);
    expect(output.options.reasoning_effort).toBe("none");
    expect(output.temperature).toBe(0.7);
  });

  it("provider remoto: nessuna mutazione", async () => {
    const hooks = createHexagonHooks({ workspaceDir: "/virtual/repo" });
    const { input, output } = chatIO("openai");
    await hooks["chat.params"]!(input, output);
    expect(output.options).toEqual({});
  });
});

describe("hook event / session.created", () => {
  it("avvia il bootstrap alla creazione sessione", async () => {
    const bootstrap = vi.fn(async () => undefined);
    const hooks = createHexagonHooks({ workspaceDir: "/virtual/repo", bootstrap });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await hooks.event!({
      event: { type: "server.instance.disposed" } as EventInput,
    });
  });

  it("altri eventi non avviano il bootstrap", async () => {
    const bootstrap = vi.fn(async () => undefined);
    const hooks = createHexagonHooks({ workspaceDir: "/virtual/repo", bootstrap });
    await hooks.event!({
      event: { type: "session.updated" } as EventInput,
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("bootstrap fallito: errore loggato, nessuna eccezione non gestita", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bootstrap = vi.fn(async () => {
      throw new Error("NPU non disponibile");
    });
    const hooks = createHexagonHooks({ workspaceDir: "/virtual/repo", bootstrap });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(String(errorSpy.mock.calls[0][1])).toContain("NPU non disponibile");
    errorSpy.mockRestore();
  });

  it("bootstrap di default: session.created esegue il wiring reale con deps iniettate", async () => {
    const { fn: exec } = recordingExec((call) =>
      okExec(
        call.command.endsWith("geniex.exe")
          ? GENIEX_VERSION_OUTPUT
          : LLAMA_VERSION_OUTPUT,
      ),
    );
    const { fn: fetch, calls } = recordingFetch((call) => routerResponse(call.url));
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/models",
      iniPath: "/virtual/repo/hexagon-models.ini",
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      mkdir: async () => {},
      deps: {
        exec,
        fetch,
        spawn: recordingSpawn(111).fn,
        readFile: async () => "",
        writeFile: async () => {},
        exists: async () => true,
        listDir: async () => ALL_RUNTIME_FILES,
        sleep: async () => {},
        now: () => 0,
      },
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await vi.waitFor(() =>
      expect(calls.some((call) => call.url.endsWith("/health"))).toBe(true),
    );
    await hooks.event!({
      event: { type: "server.instance.disposed" } as EventInput,
    });
  });

  it("session.created: nessun benchmark/model-watcher automatico avviato all'avvio senza espresso consenso", async () => {
    const watcherFactory = vi.fn();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startModelWatcherFn: watcherFactory,
      startWatchdogFn: () => ({ stop: vi.fn(), running: true }),
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(watcherFactory).not.toHaveBeenCalled();
  });

  it("session.created con enableAutoBenchmark: avvia il model watcher e logga callback", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let capturedOpts: ModelWatcherOptions | undefined;
    const watcherFactory = vi.fn((opts: ModelWatcherOptions) => {
      capturedOpts = opts;
      return {
        checkNow: vi.fn(async () => []),
        stop: vi.fn(),
      };
    });
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      enableAutoBenchmark: true,
      startModelWatcherFn: watcherFactory,
      startWatchdogFn: () => ({ stop: vi.fn(), running: true }),
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalledTimes(1));

    capturedOpts!.onModelsDiscovered!(["m1", "m2"]);
    capturedOpts!.onQualified!("m1", true);
    capturedOpts!.onQualified!("m2", false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Rilevati e configurati 2 nuovi modelli"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("qualificato con successo"));
    logSpy.mockRestore();
  });

  it("session.created con HEXAGON_ENABLE_AUTO_BENCHMARK=true avvia e ferma model watcher", async () => {
    const saved = process.env.HEXAGON_ENABLE_AUTO_BENCHMARK;
    process.env.HEXAGON_ENABLE_AUTO_BENCHMARK = "true";
    try {
      const stopWatcher = vi.fn();
      const watcherFactory = vi.fn(() => ({
        checkNow: vi.fn(async () => []),
        stop: stopWatcher,
      }));
      const hooks = createHexagonHooks({
        workspaceDir: "",
        bootstrap: async () => undefined,
        startModelWatcherFn: watcherFactory,
        startWatchdogFn: () => ({ stop: vi.fn(), running: true }),
      });
      await hooks.event!({
        event: { type: "session.created" } as EventInput,
      });
      await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalledTimes(1));
      await hooks.event!({
        event: { type: "session.deleted" } as EventInput,
      });
      expect(stopWatcher).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.HEXAGON_ENABLE_AUTO_BENCHMARK;
      else process.env.HEXAGON_ENABLE_AUTO_BENCHMARK = saved;
    }
  });

  it("disableModelWatcher: true impedisce avvio del watcher anche con enableAutoBenchmark", async () => {
    const watcherFactory = vi.fn();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      enableAutoBenchmark: true,
      disableModelWatcher: true,
      startModelWatcherFn: watcherFactory,
      startWatchdogFn: () => ({ stop: vi.fn(), running: true }),
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(watcherFactory).not.toHaveBeenCalled();
  });

  it("session.created concorrenti: bootstrap serializzato e nessun avvio parallelo", async () => {
    let resolveBootstrap: () => void;
    const bootstrapPromise = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const bootstrap = vi.fn(() => bootstrapPromise);
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap,
      startWatchdogFn: () => ({ stop: vi.fn(), running: true }),
    });
    const ev1 = hooks.event!({ event: { type: "session.created" } as EventInput });
    const ev2 = hooks.event!({ event: { type: "session.created" } as EventInput });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    resolveBootstrap!();
    await Promise.all([ev1, ev2]);
  });

  it("session.created -> session.deleted prima della risoluzione di bootstrap non avvia watchdog ne' modelWatcher", async () => {
    let resolveBootstrap: () => void;
    const bootstrapPromise = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const startWatchdogFn = vi.fn(() => ({ stop: vi.fn(), running: true }));
    const startModelWatcherFn = vi.fn(() => ({ stop: vi.fn(), checkNow: vi.fn(async () => []) }));
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: () => bootstrapPromise,
      enableAutoBenchmark: true,
      startWatchdogFn,
      startModelWatcherFn,
    });

    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await hooks.event!({ event: { type: "session.deleted" } as EventInput });
    resolveBootstrap!();
    await new Promise((r) => setTimeout(r, 15));

    expect(startWatchdogFn).not.toHaveBeenCalled();
    expect(startModelWatcherFn).not.toHaveBeenCalled();
  });
});

describe("bootstrapRuntime", () => {
  function runtimeDeps(options: { aligned: boolean; serverUp: boolean }) {
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell") {
        return okExec('{"Message":"runtime allineato","Files":["ggml-hexagon.dll"]}');
      }
      if (call.command.endsWith("geniex.exe")) {
        return okExec(
          options.aligned
            ? GENIEX_VERSION_OUTPUT
            : "LlamaCPP Runtime Hash: abcdef123\n",
        );
      }
      return okExec(LLAMA_VERSION_OUTPUT);
    });
    let serverDown = !options.serverUp;
    const { fn: fetch } = recordingFetch((call) => {
      if (serverDown) {
        throw new Error("ECONNREFUSED");
      }
      return routerResponse(call.url);
    });
    const { fn: spawnBase, calls: spawnCalls } = recordingSpawn(777);
    const spawn: SpawnFn = (command, args, spawnOptions) => {
      serverDown = false;
      return spawnBase(command, args, spawnOptions);
    };
    const deps = {
      exec,
      fetch,
      spawn,
      exists: async () => true,
      listDir: async () => ALL_RUNTIME_FILES,
      readFile: async () => "",
      writeFile: async () => {},
      sleep: async () => {},
      now: () => 0,
    };
    return { deps, calls, spawnCalls };
  }

  it("tutto allineato e server attivo: nessuna azione distruttiva (anche se listDir/reload falliscono)", async () => {
    const { deps, spawnCalls } = runtimeDeps({ aligned: true, serverUp: true });
    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/models",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: {
        ...deps,
        listDir: async (dir) => {
          if (dir.includes("models")) throw new Error("models dir unreadable");
          return ALL_RUNTIME_FILES;
        },
        readFile: async () => {
          throw new Error("ini unreadable");
        },
      },
    });
    expect(result.sync.updated).toBe(false);
    expect(result.ini.generated).toBe(false);
    expect(result.server.started).toBe(false);
    expect(result.health.ready).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  it("disallineato e server spento: sync + avvio con ADSP_LIBRARY_PATH + health", async () => {
    const { deps, calls, spawnCalls } = runtimeDeps({
      aligned: false,
      serverUp: false,
    });
    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/models",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps,
    });
    expect(result.sync.updated).toBe(true);
    expect(result.server.started).toBe(true);
    expect(result.server.pid).toBe(777);
    expect(result.health.ready).toBe(true);
    expect(calls.some((call) => call.command === "powershell")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    const spawn = spawnCalls[0];
    expect(spawn.command.endsWith("llama-server.exe")).toBe(true);
    expect(spawn.options?.env?.ADSP_LIBRARY_PATH).toContain(
      "llama-bin-win-cpu-arm64",
    );
    expect(
      spawn.args[spawn.args.indexOf("--models-preset") + 1],
    ).toContain("hexagon-models.ini");
  });

  it("INI assente: generazione zero-setup in TypeScript senza launch-hexagon.ps1", async () => {
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell") {
        if (call.args.some((arg) => arg.includes("inspect-gguf.ps1"))) {
          return okExec(
            JSON.stringify({
              architecture: "qwen35",
              model_name: "Fixture Model",
              context_length: 65536,
              embedding_length: 4096,
              block_count: 32,
              head_count: 16,
              head_count_kv: 4,
              expert_count: 0,
              expert_used_count: 0,
              sliding_window: 0,
              file_type: 2,
              file_size_bytes: 5_000_000_000,
              size_gb: 4.66,
              quant_name: "Q4_0",
              is_moe: false,
            }),
          );
        }
        return okExec('{"Message":"allineato","Files":[]}');
      }
      return okExec(
        call.command.endsWith("geniex.exe")
          ? GENIEX_VERSION_OUTPUT
          : LLAMA_VERSION_OUTPUT,
      );
    });
    const { fn: writeFile, calls: writes } = recordingWriteFile();
    const { fn: fetch } = recordingFetch((call) => routerResponse(call.url));
    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/models",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: {
        exec,
        fetch,
        readFile: async () => "",
        writeFile,
        exists: async (path) => !path.endsWith("hexagon-models.ini"),
        listDir: async (dir) =>
          dir.includes("models") ? ["fixture.gguf"] : ALL_RUNTIME_FILES,
        spawn: recordingSpawn().fn,
        sleep: async () => {},
        now: () => 0,
      },
    });
    expect(result.ini.generated).toBe(true);
    expect(result.ini.modelCount).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain("hexagon-models.ini");
    expect(writes[0].content).toContain("[fixture]");
    expect(writes[0].content).toContain("device = HTP0");
    expect(calls.some((c) => c.args.some((a) => a.includes("launch-hexagon.ps1")))).toBe(false);
    expect(calls.some((c) => c.args.some((a) => a.includes("inspect-gguf.ps1")))).toBe(true);
  });

  it("NESSUN DOPPIO RIAVVIO durante update runtime + nuova discovery su Router gestito attivo", async () => {
    const paths = defaultPaths("/virtual/repo");
    const iniPath = "/virtual/repo/hexagon-models.ini";
    const modelsDir = "/virtual/models";
    const storage = new Map<string, string>([
      [
        iniPath,
        "[*]\nthreads = 12\n\n[Ornith-1.5-9B-Q4_0]\nmodel = /virtual/models/Ornith-1.5-9B-Q4_0.gguf\ndevice = HTP0\nctx-size = 65536\n",
      ],
    ]);
    let synced = false;
    let serverRunning = true;
    const events: string[] = [];

    const runningRouterProc = [
      {
        ProcessId: 9001,
        ParentProcessId: 1,
        ExecutablePath: paths.serverExe,
        CommandLine: `"${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`,
      },
    ];

    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.some((a) => a.includes("Win32_Process"))) {
        return okExec(serverRunning ? JSON.stringify(runningRouterProc) : "[]");
      }
      if (call.command === "ps") {
        return okExec(
          serverRunning
            ? `9001 1 "${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`
            : "",
        );
      }
      if (call.command === "taskkill" || call.command === "kill") {
        events.push("stopServer");
        serverRunning = false;
        return okExec("");
      }
      if (call.command === "powershell" && call.args.includes("-Apply")) {
        events.push("sync-geniex");
        synced = true;
        return okExec('{"Message":"runtime aggiornato","Files":["ggml-hexagon.dll"]}');
      }
      if (call.command.endsWith("geniex.exe")) {
        return okExec(GENIEX_VERSION_OUTPUT);
      }
      return okExec(synced ? LLAMA_VERSION_OUTPUT : "version: 11000 (0000000)");
    });

    const { fn: fetch } = recordingFetch((call) => {
      if (!serverRunning) throw new Error("ECONNREFUSED");
      if (call.url.endsWith("/v1/models")) {
        const ini = storage.get(iniPath) ?? "";
        const ids = ini.includes("[nuovo-modello]")
          ? ["Ornith-1.5-9B-Q4_0", "nuovo-modello"]
          : ["Ornith-1.5-9B-Q4_0"];
        return {
          status: 200,
          ok: true,
          json: async () => ({ object: "list", data: ids.map((id) => ({ id })) }),
          text: async () => "",
        };
      }
      return routerResponse(call.url);
    });

    const { fn: spawnBase, calls: spawnCalls } = recordingSpawn(9002);
    const spawn: SpawnFn = (command, args, opts) => {
      events.push("spawnServer");
      serverRunning = true;
      return spawnBase(command, args, opts);
    };

    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir,
      iniPath,
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      mkdir: async () => {},
      deps: {
        exec,
        fetch,
        spawn,
        exists: async (p) => !p.endsWith("kilo.json"),
        listDir: async (d) =>
          d.includes("models")
            ? ["Ornith-1.5-9B-Q4_0.gguf", "nuovo-modello.gguf"]
            : ALL_RUNTIME_FILES,
        readFile: async (p) => storage.get(p) ?? "",
        writeFile: async (p, c) => {
          if (p === iniPath) events.push("updateIni");
          storage.set(p, c);
        },
        sleep: async () => {},
        now: () => 0,
      },
    });

    expect(result.sync.updated).toBe(true);
    expect(result.catalog?.addedModels).toEqual(["nuovo-modello"]);
    expect(result.server.started).toBe(true);
    expect(result.reload?.reloaded).toBe(false);
    // Verifica: 1 solo stop, -NoStopServer a sync-geniex, update INI prima di spawn, 1 solo avvio!
    expect(events).toEqual(["stopServer", "sync-geniex", "updateIni", "spawnServer"]);
    expect(spawnCalls).toHaveLength(1);
    const applyCall = calls.find((c) => c.args.includes("-Apply"));
    expect(applyCall?.args).toContain("-NoStopServer");
  });

  it("bootstrapRuntime allineato + nuova discovery: waitForHealth prima di reloadServerIfStale e nessun riavvio su Direct-mode", async () => {
    const paths = defaultPaths("/virtual/repo");
    const iniPath = "/virtual/repo/hexagon-models.ini";
    const modelsDir = "/virtual/models";
    const storage = new Map<string, string>([
      [
        iniPath,
        "[*]\nthreads = 12\n\n[Ornith-1.5-9B-Q4_0]\nmodel = /virtual/models/Ornith-1.5-9B-Q4_0.gguf\ndevice = HTP0\nctx-size = 65536\n",
      ],
    ]);
    const directProc = [
      {
        ProcessId: 9111,
        ParentProcessId: 1,
        ExecutablePath: paths.serverExe,
        CommandLine: `"${paths.serverExe}" --port 18803 -m /virtual/models/Ornith-1.5-9B-Q4_0.gguf`,
      },
    ];
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.some((a) => a.includes("Win32_Process"))) {
        return okExec(JSON.stringify(directProc));
      }
      if (call.command === "ps") {
        return okExec(`9111 1 "${paths.serverExe}" --port 18803 -m /virtual/models/Ornith-1.5-9B-Q4_0.gguf`);
      }
      if (call.command.endsWith("geniex.exe")) return okExec(GENIEX_VERSION_OUTPUT);
      return okExec(LLAMA_VERSION_OUTPUT);
    });
    const { fn: fetch } = recordingFetch((call) =>
      call.url.endsWith("/v1/models")
        ? fakeResponse(200, { object: "list", data: [{ id: "Ornith-1.5-9B-Q4_0" }] })
        : routerResponse(call.url),
    );
    const { fn: spawn, calls: spawnCalls } = recordingSpawn();

    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir,
      iniPath,
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      mkdir: async () => {},
      deps: {
        exec,
        fetch,
        spawn,
        exists: async (p) => !p.endsWith("kilo.json"),
        listDir: async (d) =>
          d.includes("models") ? ["Ornith-1.5-9B-Q4_0.gguf", "extra.gguf"] : ALL_RUNTIME_FILES,
        readFile: async (p) => storage.get(p) ?? "",
        writeFile: async (p, c) => {
          storage.set(p, c);
        },
        sleep: async () => {},
        now: () => 0,
      },
    });

    expect(result.catalog?.addedModels).toEqual(["extra"]);
    expect(result.reload?.reloaded).toBe(false);
    expect(spawnCalls).toHaveLength(0);
    expect(calls.some((c) => c.command === "taskkill" || c.command === "kill")).toBe(false);
  });

  it("bootstrapRuntime allineato + nuova discovery su Router gestito: reload post-health e waitForHealth", async () => {
    const paths = defaultPaths("/virtual/repo");
    const iniPath = "/virtual/repo/hexagon-models.ini";
    const modelsDir = "/virtual/models";
    const storage = new Map<string, string>([
      [
        iniPath,
        "[*]\nthreads = 12\n\n[Ornith-1.5-9B-Q4_0]\nmodel = /virtual/models/Ornith-1.5-9B-Q4_0.gguf\ndevice = HTP0\nctx-size = 65536\n",
      ],
    ]);
    let serverRunning = true;
    let reloadedOnce = false;
    const routerProc = [
      {
        ProcessId: 9333,
        ParentProcessId: 1,
        ExecutablePath: paths.serverExe,
        CommandLine: `"${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`,
      },
    ];
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.some((a) => a.includes("Win32_Process"))) {
        return okExec(JSON.stringify(routerProc));
      }
      if (call.command === "ps") {
        return okExec(
          `9333 1 "${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`,
        );
      }
      if (call.command === "taskkill" || call.command === "kill") {
        serverRunning = false;
        return okExec("");
      }
      if (call.command.endsWith("geniex.exe")) return okExec(GENIEX_VERSION_OUTPUT);
      return okExec(LLAMA_VERSION_OUTPUT);
    });
    const { fn: fetch, calls: fetchCalls } = recordingFetch((call) => {
      if (!serverRunning) throw new Error("ECONNREFUSED");
      if (call.url.endsWith("/v1/models")) {
        return fakeResponse(200, {
          object: "list",
          data: reloadedOnce
            ? [{ id: "Ornith-1.5-9B-Q4_0" }, { id: "extra" }]
            : [{ id: "Ornith-1.5-9B-Q4_0" }],
        });
      }
      return routerResponse(call.url);
    });
    const { fn: spawnBase, calls: spawnCalls } = recordingSpawn(9334);
    const spawn: SpawnFn = (command, args, opts) => {
      serverRunning = true;
      reloadedOnce = true;
      return spawnBase(command, args, opts);
    };

    const result = await bootstrapRuntime({
      workspaceDir: "/virtual/repo",
      modelsDir,
      iniPath,
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      mkdir: async () => {},
      deps: {
        exec,
        fetch,
        spawn,
        exists: async (p) => !p.endsWith("kilo.json"),
        listDir: async (d) =>
          d.includes("models") ? ["Ornith-1.5-9B-Q4_0.gguf", "extra.gguf"] : ALL_RUNTIME_FILES,
        readFile: async (p) => storage.get(p) ?? "",
        writeFile: async (p, c) => {
          storage.set(p, c);
        },
        sleep: async () => {},
        now: () => 0,
      },
    });

    expect(result.sync.updated).toBe(false);
    expect(result.catalog?.addedModels).toEqual(["extra"]);
    expect(result.reload?.reloaded).toBe(true);
    expect(result.health.ready).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.endsWith("/health")).length).toBeGreaterThanOrEqual(2);
  });

  it("bootstrapRuntime tenta ripristino server se ensureRuntime fallisce dopo stopServer scoped", async () => {
    const paths = defaultPaths("/virtual/repo");
    const iniPath = "/virtual/repo/hexagon-models.ini";
    const modelsDir = "/virtual/models";
    let serverUp = true;
    const routerProc = [
      {
        ProcessId: 9222,
        ParentProcessId: 1,
        ExecutablePath: paths.serverExe,
        CommandLine: `"${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`,
      },
    ];
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.some((a) => a.includes("Win32_Process"))) {
        return okExec(JSON.stringify(routerProc));
      }
      if (call.command === "ps") {
        return okExec(
          `9222 1 "${paths.serverExe}" --host 127.0.0.1 --port 18803 --models-dir ${modelsDir} --models-preset ${iniPath}`,
        );
      }
      if (call.command === "taskkill" || call.command === "kill") {
        serverUp = false;
        return okExec("");
      }
      if (call.command === "powershell" && call.args.includes("-Apply")) {
        return { code: 1, stdout: '{"Error":"download fallito"}', stderr: "" };
      }
      if (call.command.endsWith("geniex.exe")) return okExec(GENIEX_VERSION_OUTPUT);
      return okExec("version: 11000 (0000000)");
    });
    const { fn: spawn, calls: spawnCalls } = recordingSpawn(9223);
    await expect(
      bootstrapRuntime({
        workspaceDir: "/virtual/repo",
        modelsDir,
        iniPath,
        deps: {
          exec,
          fetch: async () => {
            if (!serverUp) throw new Error("down");
            return routerResponse("http://127.0.0.1:18803/health");
          },
          spawn,
          exists: async () => true,
          listDir: async () => ALL_RUNTIME_FILES,
          readFile: async () => "",
          writeFile: async () => {},
          sleep: async () => {},
          now: () => 0,
        },
      }),
    ).rejects.toThrow(/download fallito/);
    expect(spawnCalls).toHaveLength(1);
  });

  it("runBootstrapCycle copre fallback senza listDir e propagazione errori catalogo se non ignorati", async () => {
    const { runBootstrapCycle } = await import("../src/bootstrap.js");
    const paths = defaultPaths("/virtual/repo");
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.includes("-Apply")) {
        return okExec('{"Message":"allineato","Files":[]}');
      }
      return call.command.endsWith("geniex.exe")
        ? okExec(GENIEX_VERSION_OUTPUT)
        : okExec(LLAMA_VERSION_OUTPUT);
    });
    const cycleNoListDir = await runBootstrapCycle({
      workspaceDir: paths.workspaceDir,
      runtimeDir: paths.binPath,
      geniexDir: paths.geniexDir,
      geniexExe: paths.geniexExe,
      serverExe: paths.serverExe,
      modelsDir: paths.modelsDir,
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: {
        exec,
        fetch: recordingFetch((c) => routerResponse(c.url)).fn,
        exists: async () => true,
        readFile: async () => "",
        sleep: async () => {},
        now: () => 0,
      },
    });
    expect(cycleNoListDir.sync.updated).toBe(true);
    expect(cycleNoListDir.health?.ready).toBe(true);

    await expect(
      runBootstrapCycle({
        workspaceDir: paths.workspaceDir,
        runtimeDir: paths.binPath,
        geniexDir: paths.geniexDir,
        geniexExe: paths.geniexExe,
        serverExe: paths.serverExe,
        modelsDir: paths.modelsDir,
        iniPath: "/virtual/repo/hexagon-models.ini",
        ignoreCatalogErrors: false,
        deps: {
          exec,
          fetch: recordingFetch((c) => routerResponse(c.url)).fn,
          exists: async () => true,
          readFile: async () => "",
          writeFile: async () => {},
          listDir: async (d) => {
            if (d.includes("models")) throw new Error("catalog fail");
            return ALL_RUNTIME_FILES;
          },
          sleep: async () => {},
          now: () => 0,
        },
      }),
    ).rejects.toThrow(/catalog fail/);
  });
});

describe("hook config: provider hexagon dinamico", () => {
  const INI_TEXT =
    "[*]\nthreads = 12\n[Ornith-1.5-9B-Q4_0]\nmodel = /virtual/m/Ornith.gguf\ndevice = HTP0\nctx-size = 4096\n[extra-model]\nmodel = /virtual/m/extra.gguf\ndevice = HTP0,GPUOpenCL\nctx-size = 32768\n";

  function configDeps(iniExists: boolean) {
    return {
      exists: async (path: string) => iniExists && path.endsWith("hexagon-models.ini"),
      readFile: async () => INI_TEXT,
    };
  }

  it("inietta provider, modelli INI e contesti testati senza toccare kilo.json", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: configDeps(true),
    });
    const input = {} as ConfigInput;
    await hooks.config!(input);
    const provider = input.provider?.hexagon;
    expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider?.options?.baseURL).toBe("http://127.0.0.1:18803/v1");
    expect(provider?.models?.["Ornith-1.5-9B-Q4_0"].limit).toEqual({
      context: 65536,
      output: 16384,
    });
    expect(provider?.models?.["extra-model"].limit).toEqual({
      context: 32768,
      output: 8192,
    });
    expect(provider?.models?.["extra-model"].name).toBe(
      "extra-model (HTP0,GPUOpenCL)",
    );
    expect(provider?.models?.["flint-UD-Q4_K_XL"].limit.context).toBe(131072);
    expect(input.model).toBe("hexagon/Ornith-1.5-9B-Q4_0");
    expect(input.small_model).toBe("hexagon/extra-model");
    expect(input.agent?.explore?.model).toBe("hexagon/extra-model");
    expect(input.agent?.ask?.model).toBe("hexagon/extra-model");
  });

  it("INI assente: catalogo testato comunque disponibile", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: configDeps(false),
    });
    const input = {} as ConfigInput;
    await hooks.config!(input);
    expect(Object.keys(input.provider?.hexagon?.models ?? {})).toHaveLength(4);
  });

  it("opzioni utente e modelli ignoti preservati; scelta modello utente rispettata", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: configDeps(true),
    });
    const input = {
      model: "hexagon/flint-UD-Q4_K_XL",
      small_model: "hexagon/MiniCPM5-2B-Q4_K_M",
      provider: {
        hexagon: {
          name: "Mio Hexagon",
          options: { baseURL: "http://127.0.0.1:19999/v1", apiKey: "custom" },
          models: { "modello-utente": { name: "Utente" } },
        },
        altro: { npm: "@ai-sdk/openai-compatible" },
      },
    } as unknown as ConfigInput;
    await hooks.config!(input);
    const provider = input.provider?.hexagon;
    expect(provider?.name).toBe("Mio Hexagon");
    expect(provider?.options?.baseURL).toBe("http://127.0.0.1:19999/v1");
    expect(provider?.options?.apiKey).toBe("custom");
    expect(provider?.models?.["modello-utente"]).toEqual({ name: "Utente" });
    expect(provider?.models?.["Ornith-1.5-9B-Q4_0"]).toBeDefined();
    expect(input.provider?.altro).toBeDefined();
    expect(input.model).toBe("hexagon/flint-UD-Q4_K_XL");
  });

  it("readFile fallito: nessun crash, catalogo testato", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      iniPath: "/virtual/repo/hexagon-models.ini",
      deps: {
        exists: async () => true,
        readFile: async () => {
          throw new Error("EACCES");
        },
      },
    });
    const input = {} as ConfigInput;
    await hooks.config!(input);
    expect(Object.keys(input.provider?.hexagon?.models ?? {})).toHaveLength(4);
  });

  it("hook config propaga CERTIFIED e rimuove INCOMPATIBLE da models-registry.json", async () => {
    const regPath = "/virtual/registry/models-registry.json";
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      iniPath: "/virtual/repo/hexagon-models.ini",
      registryPath: regPath,
      deps: {
        exists: async (p) => p === "/virtual/repo/hexagon-models.ini" || p === regPath,
        readFile: async (p) =>
          p === regPath
            ? JSON.stringify({
                "Ornith-1.5-9B-Q4_0": {
                  modelId: "Ornith-1.5-9B-Q4_0",
                  status: "incompatible",
                  device: "HTP0",
                  contextWindow: 65536,
                  error: "Crash 0x200",
                  timestamp: "2026-11-25T00:00:00Z",
                },
                "extra-model": {
                  modelId: "extra-model",
                  status: "certified",
                  device: "HTP0,GPUOpenCL",
                  contextWindow: 131_072,
                  timestamp: "2026-11-25T00:00:00Z",
                },
              })
            : INI_TEXT,
      },
    });
    const input = {
      provider: {
        hexagon: {
          models: {
            "Ornith-1.5-9B-Q4_0": { name: "stale" },
          },
        },
      },
    } as unknown as ConfigInput;
    await hooks.config!(input);
    const models = input.provider?.hexagon?.models;
    expect(models?.["Ornith-1.5-9B-Q4_0"]).toBeUndefined();
    expect(models?.["extra-model"]).toEqual({
      name: "extra-model (HTP0,GPUOpenCL)",
      limit: { context: 131_072, output: 16_384 },
    });
    expect(input.model).toBe("hexagon/extra-model");
  });

  it("auto-discovery da cache differenzia model, small_model e agenti explore/ask quando Ornith è assente", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/cache/models",
      iniPath: "/virtual/repo/missing.ini",
      deps: {
        exists: async (p) => p === "/virtual/cache/models",
        listDir: async () => [
          "Qwen3.8-27B-Q4_0.gguf",
          "Spark-X2.5-4B-Q4_K_M.gguf",
        ],
        readFile: async () => "",
      },
    });
    const input = {
      model: "hexagon/Ornith-1.5-9B-Q4_0",
      small_model: "hexagon/MiniCPM5-2B-Q4_K_M",
      agent: {
        explore: { model: "hexagon/MiniCPM5-2B-Q4_K_M" },
        ask: { model: "hexagon/custom-ask" },
      },
    } as unknown as ConfigInput;
    await hooks.config!(input);
    expect(input.model).toBe("hexagon/Qwen3.8-27B-Q4_0");
    expect(input.small_model).toBe("hexagon/Spark-X2.5-4B-Q4_K_M");
    expect(input.agent?.explore?.model).toBe("hexagon/Spark-X2.5-4B-Q4_K_M");
    expect(input.agent?.ask?.model).toBe("hexagon/custom-ask");
    expect(input.provider?.hexagon?.models?.["Qwen3.8-27B-Q4_0"]).toBeDefined();
  });
});

describe("wiring watchdog negli hook", () => {
  function watchdogSpy() {
    const stop = vi.fn();
    const factory = vi.fn((_options: WatchdogOptions) => ({
      stop,
      running: true,
    }));
    return { factory, stop };
  }

  it("session.created con bootstrap riuscito: watchdog avviato una sola volta", async () => {
    const { factory } = watchdogSpy();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startWatchdogFn: factory,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(factory.mock.calls[0][0].intervalMs).toBeUndefined();
    expect(typeof factory.mock.calls[0][0].probe).toBe("function");
    expect(typeof factory.mock.calls[0][0].recover).toBe("function");
  });

  it("session.deleted: watchdog fermo solo quando l'ultima sessione chiude", async () => {
    const { factory, stop } = watchdogSpy();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startWatchdogFn: factory,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    await hooks.event!({ event: { type: "session.deleted" } as EventInput });
    expect(stop).not.toHaveBeenCalled();
    await hooks.event!({ event: { type: "session.deleted" } as EventInput });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("server.instance.disposed: watchdog fermato sempre", async () => {
    const { factory, stop } = watchdogSpy();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startWatchdogFn: factory,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    await hooks.event!({
      event: { type: "server.instance.disposed" } as EventInput,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("bootstrap fallito: nessun watchdog", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { factory } = watchdogSpy();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => {
        throw new Error("geniex assente");
      },
      startWatchdogFn: factory,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    expect(factory).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("intervallo personalizzato inoltrato alla factory", async () => {
    const { factory } = watchdogSpy();
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startWatchdogFn: factory,
      watchdogIntervalMs: 5000,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1));
    expect(factory.mock.calls[0][0].intervalMs).toBe(5000);
  });

  it("onError del watchdog: recupero fallito loggato", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let captured: WatchdogOptions | undefined;
    const factory = (opts: WatchdogOptions) => {
      captured = opts;
      return { stop: vi.fn(), running: true };
    };
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      bootstrap: async () => undefined,
      startWatchdogFn: factory,
    });
    await hooks.event!({ event: { type: "session.created" } as EventInput });
    await vi.waitFor(() => expect(captured).toBeDefined());
    captured!.onError!(new Error("porta occupata"));
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][1])).toContain("porta occupata");
    errorSpy.mockRestore();
  });

  it("watchdog reale: server down al tick -> recover con ensureServer + health", async () => {
    vi.useFakeTimers();
    try {
      let serverDown = true;
      const { fn: fetch } = recordingFetch((call) => {
        if (serverDown) throw new Error("ECONNREFUSED");
        return routerResponse(call.url);
      });
      const { fn: spawnBase, calls: spawnCalls } = recordingSpawn(555);
      const spawn: SpawnFn = (command, args, spawnOptions) => {
        serverDown = false;
        return spawnBase(command, args, spawnOptions);
      };
      const hooks = createHexagonHooks({
        workspaceDir: "/virtual/repo",
        bootstrap: async () => undefined,
        watchdogIntervalMs: 1000,
        deps: {
          fetch,
          spawn,
          exists: async () => true,
          listDir: async () => ALL_RUNTIME_FILES,
          sleep: async () => {},
          now: () => 0,
        },
      });
      await hooks.event!({ event: { type: "session.created" } as EventInput });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0].options?.env?.ADSP_LIBRARY_PATH).toContain(
        "llama-bin-win-cpu-arm64",
      );
      await hooks.event!({
        event: { type: "server.instance.disposed" } as EventInput,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(spawnCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("wiring tool sync e status negli hook", () => {
  it("hexagon_sync e hexagon_status usano workspaceDir e deps iniettate", async () => {
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell") {
        return okExec('{"Message":"forzato","Files":[]}');
      }
      return okExec(
        call.command.endsWith("geniex.exe")
          ? GENIEX_VERSION_OUTPUT
          : LLAMA_VERSION_OUTPUT,
      );
    });
    const { fn: fetch } = recordingFetch((call) => routerResponse(call.url));
    const hooks = createHexagonHooks({
      workspaceDir: "/virtual/repo",
      modelsDir: "/virtual/models",
      iniPath: "/virtual/repo/hexagon-models.ini",
      configDir: "/virtual/config",
      registryPath: "/virtual/registry.json",
      mkdir: async () => {},
      deps: {
        exec,
        fetch,
        spawn: recordingSpawn(222).fn,
        readFile: async () => "[*]\nthreads = 12\n",
        writeFile: async () => {},
        sleep: async () => {},
        now: () => 0,
        exists: async () => true,
        listDir: async () => ALL_RUNTIME_FILES,
      },
    });
    const parsed = JSON.parse(
      await hooks.tool!.hexagon_sync.execute({}, undefined as never),
    );
    expect(parsed.updated).toBe(true);
    expect(parsed.message).toBe("forzato");
    const applyCall = calls.find(
      (call) => call.command === "powershell" && call.args.includes("-Apply"),
    );
    expect(applyCall?.args[applyCall.args.indexOf("-File") + 1]).toContain(
      "sync-geniex.ps1",
    );
    expect(applyCall?.args).toContain("-NoStopServer");

    const status = JSON.parse(
      await hooks.tool!.hexagon_status.execute({}, undefined as never),
    );
    expect(status.router.ready).toBe(true);
    expect(status.runtime.commitAligned).toBe(true);
  });
});
