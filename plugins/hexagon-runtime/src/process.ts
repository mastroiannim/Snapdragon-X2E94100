/**
 * process.ts — Gestione processo llama-server.exe e routing locale.
 *
 * Porta router 18803 su 127.0.0.1. Se il server non e' attivo viene avviato
 * con ADSP_LIBRARY_PATH impostato tassativamente sulla directory runtime
 * (allocazione FastRPC/HTP). I parametri per HTP0 (NPU) e GPUOpenCL sono
 * letti da hexagon-models.ini.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecFn, ExistsFn, FetchFn, SpawnFn, WriteFileFn } from "./types.js";

export const ROUTER_PORT = 18803;
export const ROUTER_HOST = "127.0.0.1";

export interface ModelConfig {
  name: string;
  model: string;
  device: string;
  tensorSplit?: string;
  ctxSize?: number;
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
  exec: ExecFn;
  exists: ExistsFn;
  writeFile: WriteFileFn;
}

export interface EnsureIniResult {
  generated: boolean;
  modelCount: number;
}

/**
 * Zero-setup INI: se hexagon-models.ini manca, lo genera dal launcher core
 * (`launch-hexagon.ps1 -Mode Router -DryRun -Json`, unica fonte delle
 * euristiche hardware) persistendo il campo `ini_content` della preview.
 * Il DryRun JSON non scrive file ne' avvia processi.
 */
export async function ensureModelsIni(
  options: EnsureIniOptions,
): Promise<EnsureIniResult> {
  if (await options.exists(options.iniPath)) {
    return { generated: false, modelCount: 0 };
  }
  const script = join(options.workspaceDir, "launch-hexagon.ps1");
  const result = await options.exec(
    "powershell",
    [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Mode",
      "Router",
      "-DryRun",
      "-Json",
    ],
    { cwd: options.workspaceDir, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `Generazione hexagon-models.ini fallita (launch-hexagon.ps1 exit ${result.code}): ` +
        (result.stderr.trim() || result.stdout.trim() || "output vuoto"),
    );
  }
  const payload = parseJsonPayload(result.stdout);
  const content = payload.ini_content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(
      "launch-hexagon.ps1 non ha proposto contenuto INI (ini_content assente): " +
        "verificare la cache modelli GGUF.",
    );
  }
  await options.writeFile(options.iniPath, content);
  const models = Array.isArray(payload.models) ? payload.models.length : 0;
  return { generated: true, modelCount: models };
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
  localAppData: string = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
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
    iniPath: join(ws, "hexagon-models.ini"),
  };
}
