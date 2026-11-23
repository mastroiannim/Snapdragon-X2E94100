import { describe, expect, it, vi } from "vitest";
import type { Hooks, PluginInput } from "@kilocode/plugin";
import pluginInit, {
  bootstrapRuntime,
  createHexagonHooks,
  plugin,
} from "../src/index.js";
import {
  ALL_RUNTIME_FILES,
  GENIEX_VERSION_OUTPUT,
  LLAMA_VERSION_OUTPUT,
  okExec,
  recordingExec,
  recordingFetch,
  recordingSpawn,
  fakeResponse,
} from "./helpers.js";

type EventInput = Parameters<NonNullable<Hooks["event"]>>[0]["event"];
type ChatParamsInput = Parameters<NonNullable<Hooks["chat.params"]>>[0];
type ChatParamsOutput = Parameters<NonNullable<Hooks["chat.params"]>>[1];

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

  it("pluginInit ritorna gli hook con i tre tool agent", async () => {
    const hooks = await pluginInit(fakePluginInput());
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual([
      "hexagon_bench",
      "hexagon_status",
      "hexagon_sync",
    ]);
    expect(typeof hooks["chat.params"]).toBe("function");
    expect(typeof hooks.event).toBe("function");
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
    const { fn: fetch, calls } = recordingFetch(() => fakeResponse(200));
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
    let healthProbes = 0;
    const { fn: fetch } = recordingFetch(() => {
      healthProbes += 1;
      if (!options.serverUp && healthProbes === 1) {
        throw new Error("ECONNREFUSED");
      }
      return fakeResponse(200);
    });
    const { fn: spawn, calls: spawnCalls } = recordingSpawn(777);
    const deps = {
      exec,
      fetch,
      spawn,
      exists: async () => true,
      listDir: async () => ALL_RUNTIME_FILES,
      readFile: async () => "",
      sleep: async () => {},
      now: () => 0,
    };
    return { deps, calls, spawnCalls };
  }

  it("tutto allineato e server attivo: nessuna azione distruttiva", async () => {
    const { deps, spawnCalls } = runtimeDeps({ aligned: true, serverUp: true });
    const result = await bootstrapRuntime({ workspaceDir: "C:/repo", deps });
    expect(result.sync.updated).toBe(false);
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
