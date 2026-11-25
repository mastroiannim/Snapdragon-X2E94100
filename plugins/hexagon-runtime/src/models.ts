/**
 * models.ts — Context window reali testati sul Snapdragon X2 Elite.
 *
 * I contesti estesi (65.536-131.072 token) sono quelli validati sul runtime
 * Hexagon, non i limiti dichiarati da GenieX. Per i modelli fuori catalogo
 * si usa il ctx-size della sezione INI, con fallback prudente a 65.536.
 */
import { ROUTER_PORT, type ModelsIni } from "./process.js";
import type { ModelsRegistry } from "./qualify.js";

export const LOCAL_PROVIDER_ID = "hexagon";

export const TESTED_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "Ornith-1.5-9B-Q4_0": 65_536,
  "MiniCPM5-2B-Q4_K_M": 65_536,
  "flint-UD-Q4_K_XL": 131_072,
  "gpt-oss-20b-Q4_0": 131_072,
};

export const DEFAULT_CONTEXT_WINDOW = 65_536;

export function isLocalModel(providerID: string): boolean {
  return providerID === LOCAL_PROVIDER_ID;
}

export function contextWindowFor(
  modelId: string,
  ini?: ModelsIni,
  registry?: ModelsRegistry,
): number {
  const reg = registry?.[modelId];
  if (reg?.status === "certified" && typeof reg.contextWindow === "number" && reg.contextWindow > 0) {
    return reg.contextWindow;
  }
  const tested = TESTED_CONTEXT_WINDOWS[modelId];
  if (tested !== undefined) return tested;
  const fromIni = ini?.models?.[modelId]?.ctxSize;
  return typeof fromIni === "number" && Number.isFinite(fromIni)
    ? fromIni
    : DEFAULT_CONTEXT_WINDOW;
}

export interface ModelDescriptor {
  id: string;
  contextWindow: number;
  device?: string;
  tested: boolean;
  status: "certified" | "untested" | "incompatible";
}

/**
 * Catalogo: modelli testati + sezioni INI + registro models-registry.json, senza duplicati.
 * Propaga lo stato CERTIFIED/INCOMPATIBLE empirico dal registro locale.
 */
export function listKnownModels(
  ini?: ModelsIni,
  registry?: ModelsRegistry,
): ModelDescriptor[] {
  const descriptors = new Map<string, ModelDescriptor>();
  const modelsMap = ini?.models ?? {};
  const regMap = registry ?? {};

  for (const [id, contextWindow] of Object.entries(TESTED_CONTEXT_WINDOWS)) {
    const reg = regMap[id];
    const iniDevice = modelsMap[id]?.device;
    if (reg?.status === "incompatible") {
      descriptors.set(id, {
        id,
        contextWindow: reg.contextWindow > 0 ? reg.contextWindow : contextWindow,
        device: reg.device || iniDevice,
        tested: false,
        status: "incompatible",
      });
    } else if (reg?.status === "certified") {
      descriptors.set(id, {
        id,
        contextWindow: reg.contextWindow > 0 ? reg.contextWindow : contextWindow,
        device: reg.device || iniDevice,
        tested: true,
        status: "certified",
      });
    } else {
      descriptors.set(id, {
        id,
        contextWindow,
        device: iniDevice,
        tested: true,
        status: "certified",
      });
    }
  }

  for (const [id, config] of Object.entries(modelsMap)) {
    if (descriptors.has(id)) continue;
    const reg = regMap[id];
    if (reg?.status === "incompatible") {
      descriptors.set(id, {
        id,
        contextWindow: contextWindowFor(id, ini, registry),
        device: reg.device || config.device,
        tested: false,
        status: "incompatible",
      });
    } else if (reg?.status === "certified") {
      descriptors.set(id, {
        id,
        contextWindow: contextWindowFor(id, ini, registry),
        device: reg.device || config.device,
        tested: true,
        status: "certified",
      });
    } else {
      descriptors.set(id, {
        id,
        contextWindow: contextWindowFor(id, ini, registry),
        device: config.device,
        tested: false,
        status: "untested",
      });
    }
  }

  for (const [id, prof] of Object.entries(regMap)) {
    if (descriptors.has(id) || !prof) continue;
    const ctx =
      typeof prof.contextWindow === "number" && prof.contextWindow > 0
        ? prof.contextWindow
        : DEFAULT_CONTEXT_WINDOW;
    if (prof.status === "incompatible") {
      descriptors.set(id, {
        id,
        contextWindow: ctx,
        device: prof.device,
        tested: false,
        status: "incompatible",
      });
    } else if (prof.status === "certified") {
      descriptors.set(id, {
        id,
        contextWindow: ctx,
        device: prof.device,
        tested: true,
        status: "certified",
      });
    }
  }

  return [...descriptors.values()];
}

/**
 * Limite di output: stessa regola di kilo_config.py, cosi' la configurazione
 * dinamica del plugin e' coerente con il generatore statico.
 */
export function outputLimitFor(contextWindow: number): number {
  return contextWindow > 8_192
    ? Math.min(16_384, Math.floor(contextWindow / 4))
    : Math.max(1_024, Math.floor(contextWindow / 2));
}

export interface HexagonProviderConfig {
  name: string;
  npm: string;
  options: { baseURL: string; apiKey: string };
  models: Record<string, { name: string; limit: { context: number; output: number } }>;
}

/**
 * Configurazione dinamica del provider hexagon: catalogo testato + sezioni
 * INI + models-registry.json (esclude modelli INCOMPATIBLE, promuove CERTIFIED).
 * Usata dall'hook `config` per arricchire la configurazione Kilo a runtime.
 */
export function buildHexagonProvider(
  ini?: ModelsIni,
  registry?: ModelsRegistry,
): HexagonProviderConfig {
  const models: HexagonProviderConfig["models"] = {};
  for (const descriptor of listKnownModels(ini, registry)) {
    if (descriptor.status === "incompatible") continue;
    const device = descriptor.device ?? "HTP0";
    models[descriptor.id] = {
      name: `${descriptor.id} (${device})`,
      limit: {
        context: descriptor.contextWindow,
        output: outputLimitFor(descriptor.contextWindow),
      },
    };
  }
  return {
    name: "Hexagon Local Runtime",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `http://127.0.0.1:${ROUTER_PORT}/v1`, apiKey: "local" },
    models,
  };
}
