/**
 * process.ts — Gestione processo llama-server.exe e routing locale.
 *
 * Porta router 18803 su 127.0.0.1. Se il server non e' attivo viene avviato
 * con ADSP_LIBRARY_PATH impostato tassativamente sulla directory runtime
 * (allocazione FastRPC/HTP). I parametri per HTP0 (NPU) e GPUOpenCL sono
 * letti da hexagon-models.ini.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateModelsIni } from "./discovery.js";
import { waitForHealth, type HealthResult } from "./health.js";
import { nodeListDir, nodeWriteFile } from "./os.js";
import type { ModelsRegistry } from "./qualify.js";
import type {
  ExecFn,
  ExistsFn,
  FetchFn,
  IsDirFn,
  ListDirFn,
  MkdirFn,
  NowFn,
  ReadFileFn,
  SleepFn,
  SpawnFn,
  WriteFileFn,
} from "./types.js";

export const BUNDLED_ASSETS_DIR = fileURLToPath(new URL("../assets", import.meta.url));
export const BUNDLED_INI_PATH = join(BUNDLED_ASSETS_DIR, "hexagon-models.ini");
export const BUNDLED_SCRIPTS_DIR = join(BUNDLED_ASSETS_DIR, "scripts");
export const BUNDLED_SYNC_SCRIPT = join(BUNDLED_SCRIPTS_DIR, "sync-geniex.ps1");
export const BUNDLED_BENCH_SCRIPT = join(BUNDLED_SCRIPTS_DIR, "benchmark-hexagon.ps1");
export const BUNDLED_INSPECT_SCRIPT = join(BUNDLED_SCRIPTS_DIR, "inspect-gguf.ps1");

export interface ResolveIniOptions {
  workspaceDir?: string;
  localAppData?: string;
  exists?: (path: string) => boolean;
}

/**
 * Risoluzione gerarchica di hexagon-models.ini:
 * 1. Override esplicito nel workspace: <workspaceDir>/hexagon-models.ini
 * 2. Override utente: %LOCALAPPDATA%/Hexagon/hexagon-models.ini
 * 3. Default distribuito col plugin: assets/hexagon-models.ini
 */
export function resolveIniPath(options: ResolveIniOptions = {}): string {
  const exists = options.exists ?? existsSync;
  if (options.workspaceDir) {
    const wsIni = join(options.workspaceDir, "hexagon-models.ini");
    if (exists(wsIni)) return wsIni;
  }
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (localAppData) {
    const userIni = join(localAppData, "Hexagon", "hexagon-models.ini");
    if (exists(userIni)) return userIni;
  }
  return BUNDLED_INI_PATH;
}

export const ROUTER_PORT = 18803;
export const ROUTER_HOST = "127.0.0.1";

export interface ModelConfig {
  name: string;
  model: string;
  device: string;
  tensorSplit?: string;
  ctxSize?: number;
  mmproj?: string;
  /** Altri flag della sezione INI preservati senza interpretarli. */
  flags: Record<string, string>;
}

export interface ModelsIni {
  globals: Record<string, string>;
  models: Record<string, ModelConfig>;
}

/** Parser INI minimale: sezioni [nome], default globali [*], commenti #/;. */
export function parseModelsIni(text?: string): ModelsIni {
  const globals: Record<string, string> = {};
  const models: Record<string, ModelConfig> = {};
  if (!text || typeof text !== "string") return { globals, models };
  let section: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (section !== "*" && !models[section]) {
        models[section] = { name: section, model: "", device: "HTP0", flags: {} };
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || section === null) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (section === "*") {
      globals[key] = value;
      continue;
    }
    const entry = models[section];
    switch (key) {
      case "model":
        entry.model = value;
        break;
      case "device":
        entry.device = value;
        break;
      case "tensor-split":
        entry.tensorSplit = value;
        break;
      case "ctx-size": {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) entry.ctxSize = parsed;
        break;
      }
      case "mmproj":
        entry.mmproj = value;
        break;
      default:
        entry.flags[key] = value;
    }
  }
  return { globals, models };
}

export interface RouterArgsOptions {
  iniPath: string;
  modelsDir: string;
  port?: number;
  host?: string;
  modelsMax?: number;
}

/** Argomenti router: identici al_MODE Router di launch-hexagon.ps1. */
export function buildRouterArgs(options: RouterArgsOptions): string[] {
  return [
    "--host",
    options.host ?? ROUTER_HOST,
    "--port",
    String(options.port ?? ROUTER_PORT),
    "--jinja",
    "--agent",
    "-lv",
    "3",
    "--models-dir",
    options.modelsDir,
    "--models-preset",
    options.iniPath,
    "--models-max",
    String(options.modelsMax ?? 2),
  ];
}

/**
 * Argomenti per un singolo modello (mode Direct): ctx-size e device dalla
 * sezione INI, default globali [*] per batching/threads/flash-attn.
 */
export function buildDirectArgs(
  model: ModelConfig,
  globals: Record<string, string> = {},
  options: { port?: number; host?: string } = {},
): string[] {
  const args = [
    "--host",
    options.host ?? ROUTER_HOST,
    "--port",
    String(options.port ?? ROUTER_PORT),
    "--jinja",
    "--agent",
    "-np",
    "1",
    "-lm",
    globals["load-mode"] ?? "mlock",
    "-lv",
    "3",
    "-ngl",
    globals["n-gpu-layers"] ?? "999",
    "-c",
    String(model.ctxSize ?? 65_536),
    "--context-shift",
    "-b",
    globals["batch-size"] ?? "4096",
    "-ub",
    globals["ubatch-size"] ?? "512",
    "-tb",
    globals["threads-batch"] ?? "12",
    "-t",
    globals["threads"] ?? "12",
    "-fit",
    globals["fit"] ?? "off",
    "-dev",
    model.device,
    "-fa",
    globals["flash-attn"] ?? "on",
  ];
  if (model.tensorSplit) args.push("-ts", model.tensorSplit);
  if (model.mmproj) args.push("--mmproj", model.mmproj);
  args.push("-m", model.model, "--alias", model.name);
  return args;
}

/** Ambiente FastRPC/Hexagon: ADSP_LIBRARY_PATH e' obbligatorio per la NPU. */
export function serverEnv(
  runtimeDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ADSP_LIBRARY_PATH: runtimeDir,
    GGML_HEXAGON_OPBATCH: "512",
    GGML_HEXAGON_VTCM_SIZE: "8M",
  };
}

export interface ServerProbeOptions {
  fetch: FetchFn;
  port?: number;
  host?: string;
  timeoutMs?: number;
}

/**
 * True se una qualsiasi risposta HTTP arriva sulla porta router: il processo
 * e' in ascolto (anche 503 durante il warm-up del grafo HTP).
 */
export async function isServerActive(options: ServerProbeOptions): Promise<boolean> {
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    await options.fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface EnsureServerOptions {
  fetch: FetchFn;
  spawn: SpawnFn;
  runtimeDir: string;
  serverExe: string;
  iniPath: string;
  modelsDir: string;
  port?: number;
  host?: string;
  modelsMax?: number;
}

export interface EnsureServerResult {
  started: boolean;
  pid?: number;
  reason: string;
}

export interface RouterProbe {
  /** Una qualsiasi risposta HTTP arriva sulla porta router. */
  listening: boolean;
  /** Il rispondente e' identificato come llama-server (shape /v1/models o /health). */
  identified: boolean;
}

async function fetchWithTimeout(
  options: ServerProbeOptions,
  url: string,
): Promise<import("./types.js").HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    return await options.fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifica d'identita' del router: non basta una risposta HTTP qualsiasi.
 * llama-server e' riconosciuto dalla shape OpenAI di /v1/models (`data` array
 * o `object: "list"`) o, in fallback, dal campo `status` di /health. Un
 * processo estraneo che risponde sulla porta viene segnalato, non sovrascritto.
 */
export async function probeRouter(options: ServerProbeOptions): Promise<RouterProbe> {
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  const base = `http://${host}:${port}`;
  let listening = false;
  try {
    const models = await fetchWithTimeout(options, `${base}/v1/models`);
    listening = true;
    if (models.ok) {
      const body = (await models.json().catch(() => null)) as
        | { data?: unknown; object?: unknown }
        | null;
      if (body && (Array.isArray(body.data) || body.object === "list")) {
        return { listening: true, identified: true };
      }
    }
  } catch {
    /* nessuna risposta su /v1/models: si prova /health */
  }
  try {
    const health = await fetchWithTimeout(options, `${base}/health`);
    listening = true;
    const body = (await health.json().catch(() => null)) as
      | { status?: unknown }
      | null;
    if (body && typeof body.status === "string") {
      return { listening: true, identified: true };
    }
  } catch {
    /* nessuna risposta nemmeno su /health */
  }
  return { listening, identified: false };
}

/**
 * Avvia il server solo se la porta router e' libera. Se risponde un processo
 * identificato come llama-server non interferisce; se risponde un processo
 * estraneo rifiuta l'avvio (niente spawn su una porta occupata).
 */
export async function ensureServer(
  options: EnsureServerOptions,
): Promise<EnsureServerResult> {
  const probe = await probeRouter(options);
  if (probe.identified) {
    return {
      started: false,
      reason: "llama-server identificato sulla porta router: nessuna interferenza",
    };
  }
  if (probe.listening) {
    throw new Error(
      `Porta ${options.port ?? ROUTER_PORT} occupata da un processo non identificato ` +
      "come llama-server: avvio annullato per non interferire.",
    );
  }
  const args = buildRouterArgs(options);
  const child = options.spawn(options.serverExe, args, {
    cwd: options.runtimeDir,
    env: serverEnv(options.runtimeDir),
    detached: true,
  });
  return {
    started: true,
    pid: child.pid,
    reason: "llama-server avviato con ADSP_LIBRARY_PATH sulla directory runtime",
  };
}

export interface RouterProcessInfo {
  pid: number;
  parentPid?: number;
  executablePath?: string;
  commandLine?: string;
}

export interface ManagedRouterScope {
  serverExe?: string;
  iniPath?: string;
  modelsDir?: string;
  port?: number;
  host?: string;
}

export interface StopServerOptions extends ManagedRouterScope {
  exec: ExecFn;
  platform?: NodeJS.Platform;
}

function normalizePathForCompare(pathValue: string): string {
  const slashed = pathValue.trim().replace(/[\\/]+/g, "/");
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** Tokenizza una command line gestendo argomenti quotati con apici doppi o singoli. */
export function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

function hasCliFlag(args: string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

function getCliFlagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      return args[i + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/**
 * Verifica rigorosa che un processo llama-server corrisponda al Router gestito:
 * - ExecutablePath verificato rispetto a serverExe (se fornito);
 * - Esclude processi Direct-mode (-m / --model);
 * - Richiede --models-preset (allineato a iniPath se fornito) e --port allineato;
 * - Verifica --models-dir e --host se presenti nello scope.
 */
export function isManagedRouterProcess(
  proc: RouterProcessInfo,
  scope: ManagedRouterScope = {},
): boolean {
  if (!Number.isInteger(proc.pid) || proc.pid <= 0) return false;
  if (!proc.commandLine || !proc.commandLine.trim()) return false;

  const tokens = tokenizeCommandLine(proc.commandLine);
  if (tokens.length === 0) return false;

  const exeCandidate = proc.executablePath?.trim() || "";
  if (scope.serverExe) {
    if (!exeCandidate) return false;
    if (normalizePathForCompare(exeCandidate) !== normalizePathForCompare(scope.serverExe)) {
      return false;
    }
  } else {
    const exeName = normalizePathForCompare(exeCandidate || tokens[0]).split("/").pop() ?? "";
    if (exeName !== "llama-server.exe" && exeName !== "llama-server") {
      return false;
    }
  }

  const args = tokens.slice(1);
  if (hasCliFlag(args, "-m") || hasCliFlag(args, "--model")) {
    return false;
  }

  const preset = getCliFlagValue(args, "--models-preset");
  if (!preset) return false;
  if (scope.iniPath && normalizePathForCompare(preset) !== normalizePathForCompare(scope.iniPath)) {
    return false;
  }

  const port = getCliFlagValue(args, "--port");
  if (port !== String(scope.port ?? ROUTER_PORT)) {
    return false;
  }

  if (scope.modelsDir) {
    const modelsDirArg = getCliFlagValue(args, "--models-dir");
    if (!modelsDirArg || normalizePathForCompare(modelsDirArg) !== normalizePathForCompare(scope.modelsDir)) {
      return false;
    }
  }

  if (scope.host) {
    const hostArg = getCliFlagValue(args, "--host");
    if (hostArg && hostArg.trim() !== scope.host.trim()) {
      return false;
    }
  }

  return true;
}

/** Parsing output JSON (PowerShell Get-CimInstance) o testuale (`ps`) dei processi llama-server. */
export function parseProcessListPayload(stdout: string): RouterProcessInfo[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const out: RouterProcessInfo[] = [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const rawPid = rec.ProcessId ?? rec.pid;
        const pid = typeof rawPid === "number" ? rawPid : Number.parseInt(String(rawPid ?? ""), 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const rawParent = rec.ParentProcessId ?? rec.parentPid;
        const parentPid =
          typeof rawParent === "number"
            ? rawParent
            : rawParent !== undefined
              ? Number.parseInt(String(rawParent), 10)
              : undefined;
        out.push({
          pid,
          ...(Number.isInteger(parentPid) ? { parentPid } : {}),
          executablePath:
            typeof (rec.ExecutablePath ?? rec.executablePath) === "string"
              ? String(rec.ExecutablePath ?? rec.executablePath)
              : undefined,
          commandLine:
            typeof (rec.CommandLine ?? rec.commandLine) === "string"
              ? String(rec.CommandLine ?? rec.commandLine)
              : undefined,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  const out: RouterProcessInfo[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    const commandLine = match[3].trim();
    const firstToken = tokenizeCommandLine(commandLine)[0] ?? "";
    if (!firstToken.toLowerCase().includes("llama-server")) continue;
    out.push({
      pid,
      parentPid,
      executablePath: firstToken,
      commandLine,
    });
  }
  return out;
}

export async function listLlamaServerProcesses(
  exec: ExecFn,
  platform: NodeJS.Platform = process.platform,
): Promise<RouterProcessInfo[]> {
  const isWin = platform === "win32";
  const cmd = isWin ? "powershell" : "ps";
  const args = isWin
    ? [
        "-NoProfile",
        "-Command",
        "$p = @(Get-CimInstance Win32_Process -Filter 'Name=''llama-server.exe''' -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine); ConvertTo-Json -InputObject $p -Compress",
      ]
    : ["-eo", "pid=,ppid=,args="];
  const res = await exec(cmd, args, { timeoutMs: 15_000 });
  if (res.code !== 0) return [];
  return parseProcessListPayload(res.stdout);
}

export function findManagedRouterProcesses(
  processes: RouterProcessInfo[],
  scope: ManagedRouterScope = {},
): RouterProcessInfo[] {
  return processes.filter((proc) => isManagedRouterProcess(proc, scope));
}

function collectDescendantPids(allProcs: RouterProcessInfo[], rootPids: number[]): number[] {
  const seen = new Set<number>(rootPids);
  const queue = [...rootPids];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const proc of allProcs) {
      if (proc.parentPid === parent && !seen.has(proc.pid)) {
        seen.add(proc.pid);
        queue.push(proc.pid);
      }
    }
  }
  return [...seen];
}

async function stopMatchedRouterProcesses(
  allProcs: RouterProcessInfo[],
  managedRoots: RouterProcessInfo[],
  exec: ExecFn,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (managedRoots.length === 0) {
    return false;
  }
  const rootPids = managedRoots.map((p) => p.pid);
  if (platform === "win32") {
    const pidArgs = rootPids.flatMap((pid) => ["/PID", String(pid)]);
    const res = await exec("taskkill", ["/F", "/T", ...pidArgs]);
    return res.code === 0;
  }
  const pidsToKill = collectDescendantPids(allProcs, rootPids);
  const res = await exec("kill", ["-TERM", ...pidsToKill.map(String)]);
  return res.code === 0;
}

/**
 * Termina in modo scoped esclusivamente i processi Router gestiti (verificati per
 * ExecutablePath e argomenti Router --models-preset/--port). Non tocca mai server
 * Direct-mode o istanze esterne su altre porte/directory.
 */
export async function stopServer(options: StopServerOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  try {
    const allProcs = await listLlamaServerProcesses(options.exec, platform);
    const managedRoots = findManagedRouterProcesses(allProcs, options);
    return await stopMatchedRouterProcesses(allProcs, managedRoots, options.exec, platform);
  } catch {
    return false;
  }
}

/**
 * Recupera l'elenco dei model ID correntemente serviti dall'endpoint /v1/models del router.
 */
export async function getLoadedModels(
  options: ServerProbeOptions,
): Promise<string[]> {
  const host = options.host ?? ROUTER_HOST;
  const port = options.port ?? ROUTER_PORT;
  try {
    const res = await fetchWithTimeout(options, `http://${host}:${port}/v1/models`);
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { data?: Array<{ id?: string }> }
        | null;
      if (body && Array.isArray(body.data)) {
        return body.data.map((m) => m.id ?? "").filter(Boolean);
      }
    }
  } catch {
    /* router non risponde o errore di rete */
  }
  return [];
}

export interface ReloadIfStaleOptions extends EnsureServerOptions {
  exec: ExecFn;
  readFile?: ReadFileFn;
  sleep?: SleepFn;
  platform?: NodeJS.Platform;
}

export interface ReloadIfStaleResult {
  reloaded: boolean;
  reason: string;
  missingModels: string[];
  staleModels?: string[];
}

export interface RestartServerOptions extends EnsureServerOptions {
  exec: ExecFn;
  sleep?: SleepFn;
  now?: NowFn;
  platform?: NodeJS.Platform;
}

export interface RestartServerResult {
  restarted: boolean;
  stopped: boolean;
  started: boolean;
  pid?: number;
  reason: string;
  health: HealthResult;
  loadedModels: string[];
}

/**
 * Riavvia in modo deterministico il router llama-server (stop scoped -> breve pausa ->
 * avvio -> attesa /health -> lettura /v1/models).
 */
export async function restartServer(
  options: RestartServerOptions,
): Promise<RestartServerResult> {
  const stopped = await stopServer({
    exec: options.exec,
    serverExe: options.serverExe,
    iniPath: options.iniPath,
    modelsDir: options.modelsDir,
    port: options.port,
    host: options.host,
    platform: options.platform,
  });
  if (options.sleep) {
    await options.sleep(500);
  }
  const startRes = await ensureServer(options);
  const health = await waitForHealth({
    fetch: options.fetch,
    sleep: options.sleep,
    now: options.now,
  }).catch(() => ({ ready: false, attempts: 0, latencyMs: 0 }));
  const loadedModels = health.ready ? await getLoadedModels(options) : [];
  return {
    restarted: startRes.started,
    stopped,
    started: startRes.started,
    ...(startRes.pid !== undefined ? { pid: startRes.pid } : {}),
    reason: startRes.reason,
    health,
    loadedModels,
  };
}

/**
 * Verifica se il router llama-server attivo e' disallineato rispetto ai modelli
 * definiti in hexagon-models.ini (modelli aggiunti o rimossi). Se rileva differenze,
 * verifica che il processo attivo sia un Router gestito (ExecutablePath e argomenti
 * verificati) prima di arrestarlo e riavviarlo con il preset aggiornato.
 */
export async function reloadServerIfStale(
  options: ReloadIfStaleOptions,
): Promise<ReloadIfStaleResult> {
  const probe = await probeRouter(options);
  if (!probe.listening || !probe.identified) {
    const startRes = await ensureServer(options);
    return {
      reloaded: startRes.started,
      reason: startRes.reason,
      missingModels: [],
      staleModels: [],
    };
  }

  let iniText = "";
  if (options.readFile) {
    try {
      iniText = await options.readFile(options.iniPath);
    } catch {
      return { reloaded: false, reason: "Impossibile leggere iniPath", missingModels: [], staleModels: [] };
    }
  }
  const ini = parseModelsIni(iniText);
  const configuredModels = Object.keys(ini.models);
  if (configuredModels.length === 0) {
    return { reloaded: false, reason: "Nessun modello configurato nell'INI", missingModels: [], staleModels: [] };
  }

  const loadedModels = await getLoadedModels(options);
  const loadedSet = new Set(loadedModels);
  const configuredSet = new Set(configuredModels);
  const missingModels = configuredModels.filter((id) => !loadedSet.has(id));
  const staleModels = loadedModels.filter((id) => !configuredSet.has(id));

  if (missingModels.length === 0 && staleModels.length === 0) {
    return {
      reloaded: false,
      reason: "Tutti i modelli configurati sono già allineati sul router",
      missingModels: [],
      staleModels: [],
    };
  }

  const scope: ManagedRouterScope = {
    serverExe: options.serverExe,
    iniPath: options.iniPath,
    modelsDir: options.modelsDir,
    port: options.port,
    host: options.host,
  };
  const runningProcs = await listLlamaServerProcesses(
    options.exec,
    options.platform,
  ).catch(() => []);
  const managed = findManagedRouterProcesses(runningProcs, scope);
  if (managed.length === 0) {
    return {
      reloaded: false,
      reason:
        "Server attivo sulla porta router non riconosciuto come Router gestito " +
        "(ExecutablePath o argomenti non verificati): nessun riavvio eseguito",
      missingModels,
      staleModels,
    };
  }

  // Modelli aggiunti o rimossi su Router gestito: riavvio pulito scoped
  await stopMatchedRouterProcesses(
    runningProcs,
    managed,
    options.exec,
    options.platform ?? process.platform,
  ).catch(() => false);
  if (options.sleep) {
    await options.sleep(500);
  }

  await ensureServer(options);
  const parts: string[] = [];
  if (missingModels.length > 0) parts.push(`${missingModels.length} mancanti (${missingModels.join(", ")})`);
  if (staleModels.length > 0) parts.push(`${staleModels.length} rimossi (${staleModels.join(", ")})`);
  return {
    reloaded: true,
    reason: `llama-server riavviato per riallineare modelli: ${parts.join("; ")}`,
    missingModels,
    staleModels,
  };
}

/**
 * Estrae un payload JSON da stdout che puo' contenere diagnostica PowerShell
 * prima/dopo il JSON (ConvertTo-Json non compresso e' multi-riga).
 */
export function parseJsonPayload(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("output vuoto");
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    }
    throw new Error("payload JSON non trovato");
  }
}

export interface EnsureIniOptions {
  iniPath: string;
  workspaceDir: string;
  modelsDir?: string;
  exec: ExecFn;
  exists: ExistsFn;
  writeFile: WriteFileFn;
  readFile?: ReadFileFn;
  listDir?: ListDirFn;
  isDirectory?: IsDirFn;
  mkdir?: MkdirFn;
  inspectScript?: string;
  skipInspection?: boolean;
  registryPath?: string;
  registry?: ModelsRegistry;
}

export interface EnsureIniResult {
  generated: boolean;
  modelCount: number;
}

/**
 * Zero-setup INI: se hexagon-models.ini manca, lo genera interamente in TypeScript
 * tramite scanModels + calculateOptimalConfig (allineato 1:1 a Get-HexagonOptimalConfig),
 * senza dipendere da launch-hexagon.ps1.
 */
export async function ensureModelsIni(
  options: EnsureIniOptions,
): Promise<EnsureIniResult> {
  if (await options.exists(options.iniPath)) {
    return { generated: false, modelCount: 0 };
  }
  const modelsDir = options.modelsDir ?? defaultPaths(options.workspaceDir).modelsDir;
  const listDir = options.listDir ?? nodeListDir;
  const mkdir: MkdirFn =
    options.mkdir ??
    (options.writeFile !== nodeWriteFile
      ? async () => {}
      : (dirPath) => {
          mkdirSync(dirPath, { recursive: true });
        });

  const generated = await generateModelsIni({
    modelsDir,
    deps: {
      listDir,
      exists: options.exists,
      exec: options.exec,
      isDirectory: options.isDirectory,
      readFile: options.readFile,
    },
    inspectScript: options.inspectScript,
    skipInspection: options.skipInspection,
    registryPath: options.registryPath,
    registry: options.registry,
  });

  const targetDir = dirname(options.iniPath);
  if (!(await options.exists(targetDir))) {
    await mkdir(targetDir);
  }
  await options.writeFile(options.iniPath, generated.iniContent);
  return { generated: true, modelCount: generated.modelCount };
}

export interface HexagonPaths {
  workspaceDir: string;
  binPath: string;
  geniexDir: string;
  geniexExe: string;
  serverExe: string;
  modelsDir: string;
  iniPath: string;
}

/** Percorsi standard dello stack Hexagon su Windows ARM64. */
export function defaultPaths(
  workspaceDir?: string,
  home: string = homedir(),
  localAppData: string = process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
  exists?: (path: string) => boolean,
): HexagonPaths {
  const ws = workspaceDir && workspaceDir.length > 0 ? workspaceDir : process.cwd();
  const binPath = join(home, "llama-cpp", "llama-bin-win-cpu-arm64");
  const geniexDir = join(localAppData, "GenieX CLI");
  return {
    workspaceDir: ws,
    binPath,
    geniexDir,
    geniexExe: join(geniexDir, "geniex.exe"),
    serverExe: join(binPath, "llama-server.exe"),
    modelsDir: join(home, ".cache", "geniex", "models"),
    iniPath: resolveIniPath({ workspaceDir: ws, localAppData, exists }),
  };
}
