import { describe, expect, it } from "vitest";
import {
  buildHexagonProvider,
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  isLocalModel,
  listKnownModels,
  LOCAL_PROVIDER_ID,
  outputLimitFor,
  TESTED_CONTEXT_WINDOWS,
} from "../src/models.js";
import { parseModelsIni } from "../src/process.js";

describe("TESTED_CONTEXT_WINDOWS", () => {
  it("espone i contesti reali testati sul Snapdragon X2 Elite", () => {
    expect(TESTED_CONTEXT_WINDOWS["Ornith-1.5-9B-Q4_0"]).toBe(65_536);
    expect(TESTED_CONTEXT_WINDOWS["MiniCPM5-2B-Q4_K_M"]).toBe(65_536);
    expect(TESTED_CONTEXT_WINDOWS["flint-UD-Q4_K_XL"]).toBe(131_072);
    expect(TESTED_CONTEXT_WINDOWS["gpt-oss-20b-Q4_0"]).toBe(131_072);
  });
});

describe("isLocalModel", () => {
  it("riconosce il provider hexagon", () => {
    expect(isLocalModel("hexagon")).toBe(true);
    expect(LOCAL_PROVIDER_ID).toBe("hexagon");
  });
  it("esclude provider remoti", () => {
    expect(isLocalModel("openai")).toBe(false);
    expect(isLocalModel("")).toBe(false);
  });
});

describe("contextWindowFor", () => {
  const ini = parseModelsIni(
    "[Ornith-1.5-9B-Q4_0]\nctx-size = 4096\n[altro-modello]\nctx-size = 32768\n[senza-ctx]\nmodel = x.gguf\n",
  );

  it("il contesto testato ha precedenza sull'INI", () => {
    expect(contextWindowFor("Ornith-1.5-9B-Q4_0", ini)).toBe(65_536);
  });
  it("modelli fuori catalogo: ctx-size dall'INI", () => {
    expect(contextWindowFor("altro-modello", ini)).toBe(32_768);
  });
  it("fallback prudente senza INI o senza ctx-size", () => {
    expect(contextWindowFor("sconosciuto")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor("senza-ctx", ini)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(65_536);
  });
});

describe("listKnownModels", () => {
  it("catalogo testato senza INI", () => {
    const models = listKnownModels();
    expect(models).toHaveLength(4);
    expect(models.every((model) => model.tested)).toBe(true);
    expect(models.find((model) => model.id === "flint-UD-Q4_K_XL")?.contextWindow).toBe(131_072);
  });

  it("unione con INI senza duplicati e device preservato", () => {
    const ini = parseModelsIni(
      "[Ornith-1.5-9B-Q4_0]\ndevice = HTP0\nctx-size = 4096\n[extra]\ndevice = HTP0,GPUOpenCL\nctx-size = 8192\n",
    );
    const models = listKnownModels(ini);
    expect(models).toHaveLength(5);
    const ornith = models.find((model) => model.id === "Ornith-1.5-9B-Q4_0");
    expect(ornith?.tested).toBe(true);
    expect(ornith?.contextWindow).toBe(65_536);
    expect(ornith?.device).toBe("HTP0");
    const extra = models.find((model) => model.id === "extra");
    expect(extra?.tested).toBe(false);
    expect(extra?.contextWindow).toBe(8192);
    expect(extra?.device).toBe("HTP0,GPUOpenCL");
  });
});

describe("outputLimitFor", () => {
  it("stessa regola di kilo_config.py", () => {
    expect(outputLimitFor(4096)).toBe(2048);
    expect(outputLimitFor(8192)).toBe(4096);
    expect(outputLimitFor(32768)).toBe(8192);
    expect(outputLimitFor(65536)).toBe(16384);
    expect(outputLimitFor(131072)).toBe(16384);
  });
  it("contesti piccoli: minimo 1024", () => {
    expect(outputLimitFor(1024)).toBe(1024);
    expect(outputLimitFor(512)).toBe(1024);
  });
});

describe("buildHexagonProvider", () => {
  it("catalogo testato senza INI: provider loopback OpenAI-compatible", () => {
    const provider = buildHexagonProvider();
    expect(provider.name).toBe("Hexagon Local Runtime");
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options).toEqual({
      baseURL: "http://127.0.0.1:18803/v1",
      apiKey: "local",
    });
    expect(Object.keys(provider.models)).toHaveLength(4);
    expect(provider.models["Ornith-1.5-9B-Q4_0"]).toEqual({
      name: "Ornith-1.5-9B-Q4_0 (HTP0)",
      limit: { context: 65536, output: 16384 },
    });
    expect(provider.models["gpt-oss-20b-Q4_0"].limit.context).toBe(131072);
  });

  it("con INI: unione, device reale e contesti testati prioritari", () => {
    const ini = parseModelsIni(
      "[Ornith-1.5-9B-Q4_0]\ndevice = HTP0\nctx-size = 4096\n[extra]\ndevice = HTP0,GPUOpenCL\nctx-size = 32768\n",
    );
    const provider = buildHexagonProvider(ini);
    expect(Object.keys(provider.models)).toHaveLength(5);
    expect(provider.models["Ornith-1.5-9B-Q4_0"].limit.context).toBe(65536);
    expect(provider.models["extra"]).toEqual({
      name: "extra (HTP0,GPUOpenCL)",
      limit: { context: 32768, output: 8192 },
    });
  });
});
