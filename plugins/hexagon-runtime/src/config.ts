/**
 * config.ts — Generatore e sincronizzatore nativo TypeScript per la configurazione Kilo Code.
 *
 * Sostituisce integralmente kilo_config.py eliminando qualsiasi dipendenza da Python.
 * Gestisce la configurazione del provider "hexagon" su loopback (127.0.0.1:18803)
 * e i contesti estesi (65k-131k) per Kilo Code CLI / IDE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildHexagonProvider as baseBuildHexagonProvider,
  outputLimitFor,
  type HexagonProviderConfig,
} from "./models.js";
import {
  parseModelsIni,
  resolveIniPath,
  ROUTER_HOST,
  ROUTER_PORT,
  type ModelsIni,
} from "./process.js";
import type { ReadFileFn, WriteFileFn } from "./types.js";

export const RECOMMENDED_MAIN_MODEL = "Ornith-1.5-9B-Q4_0";
export const RECOMMENDED_SMALL_MODEL = "MiniCPM5-2B-Q4_K_M";
export const GLOBAL_CONFIG_NAME = "kilo.jsonc";
export const RESOLVED_PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/+$/, "");

export function resolvePluginSpecifier(
  options: { workspaceDir?: string; pluginSpecifier?: string } = {},
): string {
  if (options.pluginSpecifier) return options.pluginSpecifier;
  if (
    options.workspaceDir &&
    existsSync(join(options.workspaceDir, "plugins", "hexagon-runtime"))
  ) {
    return "./plugins/hexagon-runtime";
  }
  return RESOLVED_PLUGIN_DIR;
}

export { outputLimitFor as calculateOutputLimit, outputLimitFor };

/**
 * Costruisce l'oggetto provider per Kilo Code con host e porta opzionali.
 */
export function buildHexagonProvider(
  ini?: ModelsIni,
  options: { host?: string; port?: number } = {},
): HexagonProviderConfig {
  const base = baseBuildHexagonProvider(ini);
  if (options.host || options.port) {
    const host = options.host ?? ROUTER_HOST;
    const port = options.port ?? ROUTER_PORT;
    base.options.baseURL = `http://${host}:${port}/v1`;
  }
  return base;
}

export interface KiloConfig {
  $schema?: string;
  plugin?: string[];
  provider?: Record<string, unknown>;
  model?: string;
  small_model?: string;
  [key: string]: unknown;
}

/**
 * Risolve il percorso della configurazione globale di Kilo:
 * %USERPROFILE%/.config/kilo/kilo.jsonc (o kilo.json se presente).
 */
export function resolveGlobalConfigPath(customDir?: string): string {
  const base = customDir ?? join(homedir(), ".config", "kilo");
  const jsonc = join(base, GLOBAL_CONFIG_NAME);
  const json = join(base, "kilo.json");
  if (existsSync(json) && !existsSync(jsonc)) return json;
  return jsonc;
}

export interface SetupConfigOptions {
  workspaceDir?: string;
  configDir?: string;
  iniPath?: string;
  host?: string;
  port?: number;
  mainModel?: string;
  smallModel?: string;
  pluginSpecifier?: string;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
}

export interface SetupResult {
  updated: boolean;
  targetPath: string;
  backupPath?: string;
  modelCount: number;
}

/**
 * Rimuove commenti // o /* da file JSONC prima del parsing standard JSON.
 */
export function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\r\n]*/g, "");
}

/**
 * Installa o aggiorna il provider Hexagon nella configurazione globale o di workspace.
 */
export async function installProviderConfig(
  options: SetupConfigOptions = {},
): Promise<SetupResult> {
  const readFile = options.readFile ?? (async (p) => readFileSync(p, "utf-8"));
  const writeFile = options.writeFile ?? (async (p, c) => writeFileSync(p, c, "utf-8"));

  const iniPath = options.iniPath ?? resolveIniPath({ workspaceDir: options.workspaceDir });
  let iniContent = "";
  try {
    iniContent = await readFile(iniPath);
  } catch {
    /* fallback: parsing INI vuoto */
  }
  const ini = parseModelsIni(iniContent);
  const provider = buildHexagonProvider(ini);
  if (options.host || options.port) {
    const host = options.host ?? ROUTER_HOST;
    const port = options.port ?? ROUTER_PORT;
    provider.options.baseURL = `http://${host}:${port}/v1`;
  }
  const modelKeys = Object.keys(provider.models);

  const mainModel =
    options.mainModel ??
    (provider.models[RECOMMENDED_MAIN_MODEL]
      ? RECOMMENDED_MAIN_MODEL
      : (modelKeys[0] ?? "default"));
  const smallModel =
    options.smallModel ??
    (provider.models[RECOMMENDED_SMALL_MODEL]
      ? RECOMMENDED_SMALL_MODEL
      : mainModel);

  const targetPath = options.workspaceDir
    ? join(options.workspaceDir, "kilo.json")
    : resolveGlobalConfigPath(options.configDir);

  let existing: KiloConfig = {};
  let backupPath: string | undefined;

  try {
    const raw = await readFile(targetPath);
    try {
      existing = JSON.parse(stripJsonComments(raw)) as KiloConfig;
    } catch {
      existing = {};
    }
  } catch {
    /* il file non esiste ancora */
  }

  const existingProviders = (existing.provider as Record<string, unknown>) ?? {};
  const mergedProviders = { ...existingProviders, hexagon: provider };

  const existingPlugins = Array.isArray(existing.plugin) ? existing.plugin : [];
  const defaultPlugin = resolvePluginSpecifier(options);
  // Sostituisce eventuali specifier astratti non risolvibili ("@hexagon/kilo-plugin") con il percorso effettivo
  const cleanedPlugins = existingPlugins.map((p) =>
    p === "@hexagon/kilo-plugin" && defaultPlugin !== "@hexagon/kilo-plugin"
      ? defaultPlugin
      : p,
  );
  const mergedPlugins = cleanedPlugins.includes(defaultPlugin)
    ? cleanedPlugins
    : [...cleanedPlugins, defaultPlugin];

  const mergedConfig: KiloConfig = {
    $schema: existing.$schema ?? "https://app.kilo.ai/config.json",
    ...existing,
    plugin: mergedPlugins,
    provider: mergedProviders,
    model: existing.model ?? `hexagon/${mainModel}`,
    small_model: existing.small_model ?? `hexagon/${smallModel}`,
  };

  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  await writeFile(targetPath, content);

  return {
    updated: true,
    targetPath,
    backupPath,
    modelCount: modelKeys.length,
  };
}
