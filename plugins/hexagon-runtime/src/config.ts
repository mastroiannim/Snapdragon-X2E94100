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
  DEFAULT_CONTEXT_WINDOW,
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
import type { MkdirFn, NowFn, ReadFileFn, WriteFileFn } from "./types.js";

export const RECOMMENDED_MAIN_MODEL = "Ornith-1.5-9B-Q4_0";
export const RECOMMENDED_SMALL_MODEL = "MiniCPM5-2B-Q4_K_M";
export const GLOBAL_CONFIG_NAME = "kilo.jsonc";
export const RESOLVED_PLUGIN_DIR = fileURLToPath(new URL("..", import.meta.url))
  .replace(/\\/g, "/")
  .replace(/\/+$/, "");

export function resolvePluginSpecifier(
  options: {
    workspaceDir?: string;
    pluginSpecifier?: string;
    exists?: (path: string) => boolean;
  } = {},
): string {
  if (options.pluginSpecifier) return options.pluginSpecifier;
  const exists = options.exists ?? existsSync;
  if (
    options.workspaceDir &&
    exists(join(options.workspaceDir, "plugins", "hexagon-runtime"))
  ) {
    return "./plugins/hexagon-runtime";
  }
  return RESOLVED_PLUGIN_DIR;
}

export { outputLimitFor as calculateOutputLimit, outputLimitFor };

/**
 * Costruisce l'oggetto provider per Kilo Code con host, porta e modelli live opzionali.
 */
export function buildHexagonProvider(
  ini?: ModelsIni,
  options: { host?: string; port?: number; liveModels?: string[] } = {},
): HexagonProviderConfig {
  const base = baseBuildHexagonProvider(ini);
  if (options.liveModels) {
    for (const mid of options.liveModels) {
      if (mid && !base.models[mid]) {
        base.models[mid] = {
          name: `${mid} (HTP0)`,
          limit: {
            context: DEFAULT_CONTEXT_WINDOW,
            output: outputLimitFor(DEFAULT_CONTEXT_WINDOW),
          },
        };
      }
    }
  }
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
export function resolveGlobalConfigPath(
  customDir?: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const base = customDir ?? join(homedir(), ".config", "kilo");
  const jsonc = join(base, GLOBAL_CONFIG_NAME);
  const json = join(base, "kilo.json");
  if (exists(json) && !exists(jsonc)) return json;
  return jsonc;
}

export interface SetupConfigOptions {
  workspaceDir?: string;
  configDir?: string;
  iniPath?: string;
  host?: string;
  port?: number;
  liveModels?: string[];
  mainModel?: string;
  smallModel?: string;
  pluginSpecifier?: string;
  readFile?: ReadFileFn;
  writeFile?: WriteFileFn;
  exists?: (path: string) => boolean | Promise<boolean>;
  mkdir?: MkdirFn;
  now?: NowFn;
}

export interface SetupResult {
  updated: boolean;
  targetPath: string;
  backupPath?: string;
  modelCount: number;
}

/**
 * Rimuove commenti // o /* da file JSONC prima del parsing standard JSON,
 * preservando integralmente stringhe quotate (es. URL "https://...") ed escape.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  const len = text.length;

  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < len) {
          out += text[++i];
        }
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && text[i] !== "\r" && text[i] !== "\n") {
        i++;
      }
      i--;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) {
        i++;
      }
      i++;
      continue;
    }

    out += ch;
  }

  return out;
}

function formatBackupTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Installa o aggiorna il provider Hexagon nella configurazione globale o di workspace.
 * Rifiuta la sovrascrittura se il target esiste ma non e' JSON/JSONC valido;
 * se il target esiste ed e' valido, crea un backup con timestamp prima di scrivere.
 */
export async function installProviderConfig(
  options: SetupConfigOptions = {},
): Promise<SetupResult> {
  const readFile = options.readFile ?? (async (p) => readFileSync(p, "utf-8"));
  const writeFile = options.writeFile ?? (async (p, c) => writeFileSync(p, c, "utf-8"));
  const exists = options.exists ?? (async (p) => existsSync(p));
  const mkdir: MkdirFn =
    options.mkdir ??
    (options.writeFile
      ? async () => {}
      : (p) => {
          mkdirSync(p, { recursive: true });
        });
  const now = options.now ?? (() => Date.now());

  const iniPath = options.iniPath ?? resolveIniPath({ workspaceDir: options.workspaceDir });
  let iniContent = "";
  try {
    iniContent = await readFile(iniPath);
  } catch {
    /* fallback: parsing INI vuoto */
  }
  const ini = parseModelsIni(iniContent);
  const provider = buildHexagonProvider(ini, {
    host: options.host,
    port: options.port,
    liveModels: options.liveModels,
  });
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

  let targetPath: string;
  if (options.workspaceDir) {
    targetPath = join(options.workspaceDir, "kilo.json");
  } else {
    const base = options.configDir ?? join(homedir(), ".config", "kilo");
    const jsonc = join(base, GLOBAL_CONFIG_NAME);
    const json = join(base, "kilo.json");
    const hasJson = await exists(json);
    const hasJsonc = await exists(jsonc);
    targetPath = resolveGlobalConfigPath(base, (p) =>
      p === json ? hasJson : hasJsonc,
    );
  }

  let existing: KiloConfig = {};
  let originalRaw: string | undefined;
  let fileExisted = false;

  if (options.exists) {
    if (await options.exists(targetPath)) {
      originalRaw = await readFile(targetPath);
      fileExisted = true;
    }
  } else {
    try {
      originalRaw = await readFile(targetPath);
      fileExisted = true;
    } catch (err) {
      if (!options.readFile && (err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
      /* il file non esiste ancora */
    }
  }

  if (fileExisted) {
    const raw = originalRaw ?? "";
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(noBom));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Configurazione esistente in ${targetPath} non parsabile (${reason}); file lasciato intatto.`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Configurazione esistente in ${targetPath} non valida (atteso oggetto JSON); file lasciato intatto.`,
      );
    }
    existing = parsed as KiloConfig;
  }

  const existingProviders = (existing.provider as Record<string, unknown>) ?? {};
  const mergedProviders = { ...existingProviders, hexagon: provider };

  const existingPlugins = Array.isArray(existing.plugin) ? existing.plugin : [];
  const hasWorkspacePlugin = options.workspaceDir
    ? Boolean(await exists(join(options.workspaceDir, "plugins", "hexagon-runtime")))
    : false;
  const defaultPlugin = resolvePluginSpecifier({
    ...options,
    exists: () => hasWorkspacePlugin,
  });
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

  const content = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  if (fileExisted && originalRaw === content) {
    return {
      updated: false,
      targetPath,
      modelCount: modelKeys.length,
    };
  }

  const dir = dirname(targetPath);
  if (!(await exists(dir))) {
    await mkdir(dir);
  }

  let backupPath: string | undefined;
  if (fileExisted && originalRaw !== undefined) {
    const stamp = formatBackupTimestamp(new Date(now()));
    let candidate = `${targetPath}.bak-${stamp}`;
    let suffix = 1;
    while (await exists(candidate)) {
      candidate = `${targetPath}.bak-${stamp}-${suffix++}`;
    }
    backupPath = candidate;
    await writeFile(backupPath, originalRaw);
  }

  await writeFile(targetPath, content);

  return {
    updated: true,
    targetPath,
    backupPath,
    modelCount: modelKeys.length,
  };
}
