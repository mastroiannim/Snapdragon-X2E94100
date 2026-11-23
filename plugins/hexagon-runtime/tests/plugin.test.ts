import { describe, expect, it, vi } from "vitest";
import type { Hooks, PluginInput } from "@kilocode/plugin";
import pluginInit, {
  bootstrapRuntime,
  createHexagonHooks,
  plugin,
} from "../src/index.js";
import type { WatchdogOptions } from "../src/watchdog.js";
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
  fakeResponse,
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
    directory: "C:/repo/dir",
    worktree: "C:/repo",
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

  it("pluginInit ritorna gli hook con i sei tool agent", async () => {
    const hooks = await pluginInit(fakePluginInput({ disableModelWatcher: true }));
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "hexagon_bench",
      "hexagon_models",
      "hexagon_qualify",
      "hexagon_setup",
      "hexagon_status",
      "hexagon_sync",
    ]);
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks.config).toBe("function");
  });

  it("worktree vuoto: fallback su directory", async () => {
    const hooks = await pluginInit(fakePluginInput({ worktree: "" }));
    expect(hooks.tool).toBeDefined();
  });
});

describe("hook chat.params", () => {
  it("modello locale: reasoning_effort none per tool-calling deterministico", async () => {
    const hooks = createHexagonHooks({ workspaceDir: "C:/repo" });
    const { input, output } = chatIO("hexagon");
    await hooks["chat.params"]!(input, output);
    expect(output.options.reasoning_effort).toBe("none");
    expect(output.temperature).toBe(0.7);
  });

  it("provider remoto: nessuna mutazione", async () => {
    const hooks = createHexagonHooks({ workspaceDir: "C:/repo" });
    const { input, output } = chatIO("openai");
    await hooks["chat.params"]!(input, output);
    expect(output.options).toEqual({});
  });
});

describe("hook event / session.created", () => {
  it("avvia il bootstrap alla creazione sessione", async () => {
    const bootstrap = vi.fn(async () => undefined);
    const hooks = createHexagonHooks({ workspaceDir: "C:/repo", bootstrap });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("altri eventi non avviano il bootstrap", async () => {
    const bootstrap = vi.fn(async () => undefined);
    const hooks = createHexagonHooks({ workspaceDir: "C:/repo", bootstrap });
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
    const hooks = createHexagonHooks({ workspaceDir: "C:/repo", bootstrap });
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
      workspaceDir: "C:/repo",
      deps: {
        exec,
        fetch,
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
  });

  it("session.created: nessun benchmark/model-watcher automatico avviato all'avvio senza espresso consenso", async () => {
    const watcherFactory = vi.fn();
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      bootstrap: async () => undefined,
      startModelWatcherFn: watcherFactory,
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    // Attende tick del bootstrap
    await new Promise((r) => setTimeout(r, 10));
    expect(watcherFactory).not.toHaveBeenCalled();
  });

  it("session.created con enableAutoBenchmark: avvia il model watcher", async () => {
    const watcherFactory = vi.fn(() => ({
      checkNow: vi.fn(async () => []),
      stop: vi.fn(),
    }));
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      bootstrap: async () => undefined,
      enableAutoBenchmark: true,
      startModelWatcherFn: watcherFactory,
    });
    await hooks.event!({
      event: { type: "session.created" } as EventInput,
    });
    await vi.waitFor(() => expect(watcherFactory).toHaveBeenCalledTimes(1));
  });

  it("session.created concorrenti: bootstrap serializzato e nessun avvio parallelo", async () => {
    let resolveBootstrap: () => void;
    const bootstrapPromise = new Promise<void>((resolve) => {
      resolveBootstrap = resolve;
    });
    const bootstrap = vi.fn(() => bootstrapPromise);
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      bootstrap,
    });
    const ev1 = hooks.event!({ event: { type: "session.created" } as EventInput });
    const ev2 = hooks.event!({ event: { type: "session.created" } as EventInput });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    resolveBootstrap!();
    await Promise.all([ev1, ev2]);
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
    // Stato reale del server: down finche' la spawn non lo avvia.
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

  it("tutto allineato e server attivo: nessuna azione distruttiva", async () => {
    const { deps, spawnCalls } = runtimeDeps({ aligned: true, serverUp: true });
    const result = await bootstrapRuntime({ workspaceDir: "C:/repo", deps });
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
    const result = await bootstrapRuntime({ workspaceDir: "C:/repo", deps });
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

  it("INI assente: generazione zero-setup via launch-hexagon.ps1 -DryRun -Json", async () => {
    const iniContent =
      "[*]\nthreads = 12\n\n[fixture]\nmodel = C:/models/fixture.gguf\ndevice = HTP0\nctx-size = 65536\n";
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell") {
        if (call.args.some((arg) => arg.includes("launch-hexagon.ps1"))) {
          return okExec(
            JSON.stringify(
              { mode: "Router", ini_content: iniContent, models: [{ alias: "fixture" }] },
              null,
              2,
            ),
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
      workspaceDir: "C:/repo",
      deps: {
        exec,
        fetch,
        writeFile,
        exists: async (path) => !path.endsWith("hexagon-models.ini"),
        listDir: async () => ALL_RUNTIME_FILES,
        spawn: recordingSpawn().fn,
        sleep: async () => {},
        now: () => 0,
      },
    });
    expect(result.ini.generated).toBe(true);
    expect(result.ini.modelCount).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain("hexagon-models.ini");
    expect(writes[0].content).toBe(iniContent);
    const launcher = calls.find((call) =>
      call.args.some((arg) => arg.includes("launch-hexagon.ps1")),
    );
    expect(launcher?.args).toContain("-DryRun");
    expect(launcher?.args).toContain("-Json");
    expect(launcher?.args).toContain("Router");
  });
});

describe("hook config: provider hexagon dinamico", () => {
  const INI_TEXT =
    "[*]\nthreads = 12\n[Ornith-1.5-9B-Q4_0]\nmodel = C:/m/Ornith.gguf\ndevice = HTP0\nctx-size = 4096\n[extra-model]\nmodel = C:/m/extra.gguf\ndevice = HTP0,GPUOpenCL\nctx-size = 32768\n";

  function configDeps(iniExists: boolean) {
    return {
      exists: async (path: string) => iniExists && path.endsWith("hexagon-models.ini"),
      readFile: async () => INI_TEXT,
    };
  }

  it("inietta provider, modelli INI e contesti testati senza toccare kilo.json", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      deps: configDeps(true),
    });
    const input = {} as ConfigInput;
    await hooks.config!(input);
    const provider = input.provider?.hexagon;
    expect(provider?.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider?.options?.baseURL).toBe("http://127.0.0.1:18803/v1");
    // Il contesto testato (65536) prevale sul ctx-size INI (4096).
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
    expect(input.small_model).toBe("hexagon/MiniCPM5-2B-Q4_K_M");
  });

  it("INI assente: catalogo testato comunque disponibile", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      deps: configDeps(false),
    });
    const input = {} as ConfigInput;
    await hooks.config!(input);
    expect(Object.keys(input.provider?.hexagon?.models ?? {})).toHaveLength(4);
  });

  it("opzioni utente e modelli ignoti preservati; scelta modello utente rispettata", async () => {
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
      workspaceDir: "C:/repo",
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
        workspaceDir: "C:/repo",
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

describe("wiring tool sync negli hook", () => {
  it("hexagon_sync usa workspaceDir e deps iniettate", async () => {
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
    const hooks = createHexagonHooks({
      workspaceDir: "C:/repo",
      deps: {
        exec,
        exists: async () => true,
        listDir: async () => ALL_RUNTIME_FILES,
      },
    });
    const parsed = JSON.parse(
      await hooks.tool!.hexagon_sync.execute({}, undefined as never),
    );
    expect(parsed.updated).toBe(true);
    expect(parsed.message).toBe("forzato");
    const powershell = calls.find((call) => call.command === "powershell");
    expect(powershell?.args[powershell.args.indexOf("-File") + 1]).toBe(
      "C:\\repo\\sync-geniex.ps1",
    );
  });
});
