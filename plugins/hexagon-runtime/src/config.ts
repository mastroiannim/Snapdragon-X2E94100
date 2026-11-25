/**
 * config.ts — Generatore e sincronizzatore nativo TypeScript per la configurazione Kilo Code.
 *
 * Gestisce la configurazione del provider "hexagon" su loopback (127.0.0.1:18803)
 * e i contesti estesi (65k-131k) per Kilo Code CLI / IDE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveredModel } from "./discovery.js";
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
import {
  defaultRegistryPath,
  loadRegistry,
  type ModelsRegistry,
} from "./qualify.js";
import type { MkdirFn, NowFn, ReadFileFn, WriteFileFn } from "./types.js";

export const RECOMMENDED_MAIN_MODEL = "Ornith-1.5-9B-Q4_0";
export const RECOMMENDED_SMALL_MODEL = "MiniCPM5-2B-Q4_K_M";

export interface ModelCandidateInfo {
  id: string;
  sizeGb?: number;
  device?: string;
  isMoE?: boolean;
  status?: "certified" | "untested" | "incompatible";
  prefillTokPerSec?: number;
  genTokPerSec?: number;
}

export interface SelectedModels {
  mainModel: string;
  smallModel: string;
}

/** Stima approssimativa della dimensione in GB dal tag parametri nel nome (es. 27B, 9B, 2B, 0.8B). */
function estimateSizeGbFromId(id: string): number {
  const m = /(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_]|$)/i.exec(id);
  if (!m) return 5.0;
  const billions = Number.parseFloat(m[1]);
  if (!Number.isFinite(billions) || billions <= 0) return 5.0;
  return Math.round(billions * 0.56 * 100) / 100;
}

function effectiveSizeGb(c: ModelCandidateInfo): number {
  if (typeof c.sizeGb === "number" && Number.isFinite(c.sizeGb) && c.sizeGb > 0) {
    return c.sizeGb;
  }
  return estimateSizeGbFromId(c.id);
}

function scoreMainCandidate(c: ModelCandidateInfo): number {
  let score = 0;
  if (c.status === "certified") score += 60;
  if (typeof c.genTokPerSec === "number" && c.genTokPerSec >= 10) score += 30;
  else if (typeof c.genTokPerSec === "number" && c.genTokPerSec > 0) score += 15;

  const gb = effectiveSizeGb(c);
  if (gb >= 4.0 && gb <= 24.0) {
    score += 80;
    if (gb >= 4.5 && gb <= 18.0) score += 25;
  } else if (gb > 24.0) {
    score += 55;
  } else if (gb >= 2.0) {
    score -= 20;
  } else {
    // Evita che modelli minuscoli (<2 GB, es. 0.8B) battano un 8B-27B come mainModel
    score -= 120;
  }

  if (c.isMoE && (c.device === "HTP0" || c.device?.includes("HTP0"))) {
    score += 15;
  }
  if (/coder|instruct|ornith|lfm2\.5|qwen3/i.test(c.id)) {
    score += 10;
  }
  return score;
}

function scoreSmallCandidate(c: ModelCandidateInfo, mainModel: string): number {
  let score = 0;
  if (c.id !== mainModel) score += 100;
  if (c.status === "certified") score += 50;

  const gb = effectiveSizeGb(c);
  if (gb >= 1.0 && gb <= 6.0) {
    score += 60;
  } else if (gb > 0 && gb < 1.0) {
    score += 40;
  } else if (gb <= 13.5) {
    score += 10;
  } else {
    score -= 40;
  }

  if (c.device === "HTP0") score += 20;
  if (typeof c.genTokPerSec === "number" && c.genTokPerSec >= 20) score += 15;
  if (/mini|spark|gemma.*e2b|0\.8b|1\.5b|2b|3b|4b/i.test(c.id)) score += 10;
  return score;
}

/**
 * Seleziona dinamicamente la coppia (mainModel, smallModel) migliore disponibile
 * tra i modelli effettivamente presenti, evitando di hardcodare Ornith-1.5-9B-Q4_0
 * quando assente dalla cache.
 */
export function selectBestModels(
  candidates: ModelCandidateInfo[],
  fallbackMain = "default",
): SelectedModels {
  const valid = candidates.filter((c) => c.id && c.status !== "incompatible");
  if (valid.length === 0) {
    return { mainModel: fallbackMain, smallModel: fallbackMain };
  }

  const byId = new Map(valid.map((c) => [c.id, c]));
  const mainModel = byId.has(RECOMMENDED_MAIN_MODEL)
    ? RECOMMENDED_MAIN_MODEL
    : [...valid].sort((a, b) => {
        const diff = scoreMainCandidate(b) - scoreMainCandidate(a);
        if (diff !== 0) return diff;
        const sizeDiff = effectiveSizeGb(b) - effectiveSizeGb(a);
        if (Math.abs(sizeDiff) > 0.25) return sizeDiff;
        return a.id.localeCompare(b.id);
      })[0].id;

  const smallModel = byId.has(RECOMMENDED_SMALL_MODEL)
    ? RECOMMENDED_SMALL_MODEL
    : [...valid].sort((a, b) => {
        const diff = scoreSmallCandidate(b, mainModel) - scoreSmallCandidate(a, mainModel);
        if (diff !== 0) return diff;
        const sizeDiff = effectiveSizeGb(a) - effectiveSizeGb(b);
        if (Math.abs(sizeDiff) > 0.25) return sizeDiff;
        return a.id.localeCompare(b.id);
      })[0].id;

  return { mainModel, smallModel };
}
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

export interface BuildCandidatePoolOptions {
  discoveredModels?: DiscoveredModel[];
  ini?: ModelsIni;
  extraIds?: string[];
  registry?: ModelsRegistry;
  testedIds?: Readonly<Record<string, number>>;
}

/**
 * Raccoglie i candidati reali (cache GGUF, INI, router live/config esistente),
 * escludendo i modelli marcati incompatible e fondendo metriche dal registro.
 */
export function buildCandidatePool(options: BuildCandidatePoolOptions): {
  candidateMap: Map<string, ModelCandidateInfo>;
  hasRealDiscovery: boolean;
} {
  const candidateMap = new Map<string, ModelCandidateInfo>();
  const registry = options.registry;
  const testedIds = options.testedIds;

  const addCandidate = (
    id: string,
    partial: Omit<ModelCandidateInfo, "id" | "status" | "prefillTokPerSec" | "genTokPerSec"> & {
      status?: ModelCandidateInfo["status"];
      prefillTokPerSec?: number;
      genTokPerSec?: number;
    },
  ) => {
    if (!id || candidateMap.has(id)) return;
    const reg = registry?.[id];
    if (reg?.status === "incompatible" || partial.status === "incompatible") return;
    const isTested = testedIds ? id in testedIds : false;
    candidateMap.set(id, {
      id,
      sizeGb: partial.sizeGb,
      device: reg?.device || partial.device,
      isMoE: partial.isMoE,
      status: reg?.status === "certified" || isTested ? "certified" : (partial.status ?? "untested"),
      prefillTokPerSec: reg?.metrics?.prefillTokPerSec ?? partial.prefillTokPerSec,
      genTokPerSec: reg?.metrics?.genTokPerSec ?? partial.genTokPerSec,
    });
  };

  for (const m of options.discoveredModels ?? []) {
    addCandidate(m.id, {
      sizeGb: m.sizeGb,
      device: m.device,
      isMoE: m.metadata?.is_moe,
      status: m.status,
      prefillTokPerSec: m.metrics?.prefillTokPerSec,
      genTokPerSec: m.metrics?.genTokPerSec,
    });
  }
  for (const [id, cfg] of Object.entries(options.ini?.models ?? {})) {
    addCandidate(id, { device: cfg.device });
  }
  for (const id of options.extraIds ?? []) {
    addCandidate(id, {});
  }

  return { candidateMap, hasRealDiscovery: candidateMap.size > 0 };
}

/**
 * Risolve un riferimento modello (model, small_model o agente): usa override esplicito
 * se presente, sostituisce il default legacy se assente dai modelli reali, altrimenti preserva.
 */
export function resolveConfiguredModelRef(options: {
  existingValue: string | undefined;
  explicitOverride?: string;
  discoveredId: string;
  legacyDefaultId: string;
  hasRealDiscovery: boolean;
  candidateMap: Map<string, ModelCandidateInfo>;
}): string {
  if (options.explicitOverride) return `hexagon/${options.explicitOverride}`;
  if (!options.existingValue) return `hexagon/${options.discoveredId}`;
  if (
    options.hasRealDiscovery &&
    options.existingValue === `hexagon/${options.legacyDefaultId}` &&
    !options.candidateMap.has(options.legacyDefaultId)
  ) {
    return `hexagon/${options.discoveredId}`;
  }
  return options.existingValue;
}

/**
 * Costruisce l'oggetto provider per Kilo Code con host, porta, modelli live opzionali
 * e stato dal registro models-registry.json.
 */
export function buildHexagonProvider(
  ini?: ModelsIni,
  options: {
    host?: string;
    port?: number;
    liveModels?: string[];
    discoveredModels?: DiscoveredModel[];
    registry?: ModelsRegistry;
  } = {},
): HexagonProviderConfig {
  const base = baseBuildHexagonProvider(ini, options.registry);
  if (options.discoveredModels) {
    for (const m of options.discoveredModels) {
      if (!m.id || m.status === "incompatible") continue;
      if (options.registry?.[m.id]?.status === "incompatible") continue;
      const existingEntry = base.models[m.id];
      const ctx = existingEntry?.limit.context ?? m.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      base.models[m.id] = {
        name: existingEntry?.name ?? `${m.id} (${m.device || "HTP0"})`,
        limit: {
          context: ctx,
          output: outputLimitFor(ctx),
        },
      };
    }
  }
  if (options.liveModels) {
    for (const mid of options.liveModels) {
      if (!mid || base.models[mid]) continue;
      if (options.registry?.[mid]?.status === "incompatible") continue;
      base.models[mid] = {
        name: `${mid} (HTP0)`,
        limit: {
          context: DEFAULT_CONTEXT_WINDOW,
          output: outputLimitFor(DEFAULT_CONTEXT_WINDOW),
        },
      };
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
  agent?: Record<string, { model?: string; [key: string]: unknown }>;
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
  registryPath?: string;
  registry?: ModelsRegistry;
  host?: string;
  port?: number;
  liveModels?: string[];
  discoveredModels?: DiscoveredModel[];
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
  mainModel?: string;
  smallModel?: string;
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
  let registry = options.registry;
  if (
    !registry &&
    (options.registryPath ||
      (options.readFile && options.exists) ||
      (!options.readFile && !options.exists))
  ) {
    const regPath = options.registryPath ?? defaultRegistryPath();
    if (await exists(regPath)) {
      registry = await loadRegistry(regPath, { readFile });
    }
  }
  const provider = buildHexagonProvider(ini, {
    host: options.host,
    port: options.port,
    liveModels: options.liveModels,
    discoveredModels: options.discoveredModels,
    registry,
  });
  const modelKeys = Object.keys(provider.models);

  // Costruisce il pool dei modelli realmente presenti (cache / INI / router live / registry certified),
  // evitando che TESTED_CONTEXT_WINDOWS forzi Ornith-1.5-9B-Q4_0 quando assente in cache.
  const { candidateMap, hasRealDiscovery } = buildCandidatePool({
    discoveredModels: options.discoveredModels,
    ini,
    extraIds: options.liveModels,
    registry,
  });
  const selectionPool: ModelCandidateInfo[] = hasRealDiscovery
    ? [...candidateMap.values()]
    : modelKeys.map((id) => ({
        id,
        status: registry?.[id]?.status === "certified" ? "certified" : "untested",
        prefillTokPerSec: registry?.[id]?.metrics?.prefillTokPerSec,
        genTokPerSec: registry?.[id]?.metrics?.genTokPerSec,
      }));

  const selected = selectBestModels(selectionPool);
  const mainModel = options.mainModel ?? selected.mainModel;
  const smallModel = options.smallModel ?? selected.smallModel;

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

  const resolveModelField = (
    existingValue: string | undefined,
    explicitOverride: string | undefined,
    discoveredId: string,
    legacyDefaultId: string,
  ): string =>
    resolveConfiguredModelRef({
      existingValue,
      explicitOverride,
      discoveredId,
      legacyDefaultId,
      hasRealDiscovery,
      candidateMap,
    });

  const resolvedMainRef = resolveModelField(
    existing.model,
    options.mainModel,
    mainModel,
    RECOMMENDED_MAIN_MODEL,
  );
  const resolvedSmallRef = resolveModelField(
    existing.small_model,
    options.smallModel,
    smallModel,
    RECOMMENDED_SMALL_MODEL,
  );

  const existingAgents = existing.agent ?? {};
  const mergedAgents: NonNullable<KiloConfig["agent"]> = {
    ...existingAgents,
    explore: {
      ...existingAgents.explore,
      model: resolveModelField(
        existingAgents.explore?.model,
        options.smallModel,
        smallModel,
        RECOMMENDED_SMALL_MODEL,
      ),
    },
    ask: {
      ...existingAgents.ask,
      model: resolveModelField(
        existingAgents.ask?.model,
        options.smallModel,
        smallModel,
        RECOMMENDED_SMALL_MODEL,
      ),
    },
  };

  const mergedConfig: KiloConfig = {
    $schema: existing.$schema ?? "https://app.kilo.ai/config.json",
    ...existing,
    plugin: mergedPlugins,
    provider: mergedProviders,
    model: resolvedMainRef,
    small_model: resolvedSmallRef,
    agent: mergedAgents,
  };

  const content = `${JSON.stringify(mergedConfig, null, 2)}\n`;
  if (fileExisted && originalRaw === content) {
    return {
      updated: false,
      targetPath,
      modelCount: modelKeys.length,
      mainModel,
      smallModel,
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
    mainModel,
    smallModel,
  };
}
