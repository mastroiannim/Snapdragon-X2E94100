/**
 * models.ts — Context window reali testati sul Snapdragon X2 Elite.
 *
 * I contesti estesi (65.536-131.072 token) sono quelli validati sul runtime
 * Hexagon, non i limiti dichiarati da GenieX. Per i modelli fuori catalogo
 * si usa il ctx-size della sezione INI, con fallback prudente a 65.536.
 */
import type { ModelsIni } from "./process.js";

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

export function contextWindowFor(modelId: string, ini?: ModelsIni): number {
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
}

/** Catalogo: modelli testati + sezioni INI, senza duplicati. */
export function listKnownModels(ini?: ModelsIni): ModelDescriptor[] {
  const descriptors = new Map<string, ModelDescriptor>();
  const modelsMap = ini?.models ?? {};
  for (const [id, contextWindow] of Object.entries(TESTED_CONTEXT_WINDOWS)) {
    descriptors.set(id, {
      id,
      contextWindow,
      device: modelsMap[id]?.device,
      tested: true,
    });
  }
  for (const [id, config] of Object.entries(modelsMap)) {
    if (descriptors.has(id)) continue;
    descriptors.set(id, {
      id,
      contextWindow: contextWindowFor(id, ini),
      device: config.device,
      tested: false,
    });
  }
  return [...descriptors.values()];
}
