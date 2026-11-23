import { describe, expect, it } from "vitest";
import {
  contextWindowFor,
  DEFAULT_CONTEXT_WINDOW,
  isLocalModel,
  listKnownModels,
  LOCAL_PROVIDER_ID,
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
