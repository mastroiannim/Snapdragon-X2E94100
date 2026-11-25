/**
 * sync.ts — Verifica e aggiornamento dello stack GenieX / llama.cpp ARM64.
 *
 * Estrae l'hash runtime da geniex.exe --version e il commit da
 * llama-server.exe --version; se disallineati o con file mancanti invoca
 * sync-geniex.ps1 -Apply -NoStopServer -Json (il wrapper transazionale core).
 */
import { dirname, join } from "node:path";
import { BUNDLED_SYNC_SCRIPT } from "./process.js";
import type { ExecFn, ExistsFn, ListDirFn } from "./types.js";

export const REQUIRED_RUNTIME_FILES = [
  "ggml-hexagon.dll",
  "libggml-htp.cat",
  "ggml-opencl.dll",
] as const;

export const HTP_SO_PATTERN = /^libggml-htp-v\d+\.so$/;

export interface RuntimePaths {
  geniexExe: string;
  llamaServerExe: string;
  runtimeDir: string;
}

export interface SyncDeps {
  exec: ExecFn;
  exists: ExistsFn;
  listDir: ListDirFn;
}

export interface RuntimeCheck {
  geniexHash: string | null;
  llamaCommit: string | null;
  commitAligned: boolean;
  missingFiles: string[];
  staleFiles?: string[];
  serverRunning?: boolean;
  needsSync: boolean;
}

export interface RuntimeDetails extends RuntimeCheck {
  geniexInstalled: boolean;
  geniexVersion: string;
  qairtVersion: string;
  llamaServerInstalled: boolean;
  llamaServerVersion: string;
  allFilesAligned: boolean;
  catalogSignature: string;
  error?: string;
}

export interface CheckRuntimeOptions {
  workspaceDir?: string;
  geniexDir?: string;
  syncScript?: string;
}

export interface SyncOutcome {
  updated: boolean;
  message: string;
  files: string[];
  backup?: string;
  check: RuntimeCheck;
}

/** Hash pubblicato da GenieX: `LlamaCPP Runtime Hash: <hex>`. */
export function extractGeniexHash(output: string): string | null {
  const match = /LlamaCPP Runtime Hash:\s*([a-f0-9]+)/i.exec(output);
  return match ? match[1] : null;
}

/** Commit b* di llama-server: `version: 11938 (19cce6919)` o `commit <hex>`. */
export function extractLlamaCommit(output: string): string | null {
  const match = /\bcommit\s+([0-9a-f]{7,40})\b|\(([0-9a-f]{7,40})\)/i.exec(output);
  return match ? (match[1] ?? match[2]) : null;
}

function extractLabeledField(output: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([^\\r\\n]+)`, "i").exec(output);
  return match ? match[1].trim() : null;
}

/** I commit sono confrontati per prefisso (7-40 hex). */
export function sameCommit(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const hex = /^[0-9a-f]{7,40}$/i;
  if (!hex.test(left) || !hex.test(right)) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

async function checkRequiredRuntimeFiles(
  runtimeDir: string,
  deps: Pick<SyncDeps, "exists" | "listDir">,
): Promise<string[]> {
  const missingFiles: string[] = [];
  for (const name of REQUIRED_RUNTIME_FILES) {
    if (!(await deps.exists(join(runtimeDir, name)))) {
      missingFiles.push(name);
    }
  }
  let hasHtpSo = false;
  try {
    hasHtpSo = (await deps.listDir(runtimeDir)).some((name) =>
      HTP_SO_PATTERN.test(name),
    );
  } catch {
    /* directory runtime assente: il file .so risulta mancante */
  }
  if (!hasHtpSo) missingFiles.push("libggml-htp-v*.so");
  return missingFiles;
}

interface ScriptRuntimeCheckResult {
  scriptAligned?: boolean;
  commitAligned?: boolean;
  missingFiles: string[];
  staleFiles?: string[];
  serverRunning?: boolean;
}

async function runSyncCheckScript(
  paths: RuntimePaths,
  deps: Pick<SyncDeps, "exec" | "exists">,
  options?: CheckRuntimeOptions,
): Promise<ScriptRuntimeCheckResult> {
  const out: ScriptRuntimeCheckResult = { missingFiles: [] };
  if (!options?.geniexDir) return out;
  try {
    const script =
      options.syncScript ??
      (await resolveSyncScript(options.workspaceDir, deps.exists));
    const checkRes = await deps.exec(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-CheckOnly",
        "-Json",
        "-BinPath",
        paths.runtimeDir,
        "-GenieXDir",
        options.geniexDir,
      ],
      { cwd: dirname(script), timeoutMs: 30_000 },
    );
    if (checkRes.code === 0) {
      const lines = checkRes.stdout.trim().split(/\r?\n/).filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? "";
      const parsed = JSON.parse(lastLine) as {
        Aligned?: boolean;
        CommitAligned?: boolean;
        MissingFiles?: string[];
        StaleFiles?: string[];
        ServerRunning?: boolean;
      };
      if (typeof parsed.Aligned === "boolean") {
        out.scriptAligned = parsed.Aligned;
        if (typeof parsed.CommitAligned === "boolean") {
          out.commitAligned = parsed.CommitAligned;
        }
        if (Array.isArray(parsed.MissingFiles)) {
          out.missingFiles = parsed.MissingFiles;
        }
        if (Array.isArray(parsed.StaleFiles)) {
          out.staleFiles = parsed.StaleFiles;
        }
        if (typeof parsed.ServerRunning === "boolean") {
          out.serverRunning = parsed.ServerRunning;
        }
      }
    }
  } catch {
    /* fallback al controllo base se -CheckOnly non disponibile */
  }
  return out;
}

async function readCatalogSignature(
  runtimeDir: string,
  deps: Pick<SyncDeps, "exists" | "exec">,
): Promise<string> {
  const catPath = join(runtimeDir, "libggml-htp.cat");
  if (process.platform !== "win32" || !(await deps.exists(catPath))) {
    return "N/D";
  }
  const escaped = catPath.replace(/'/g, "''");
  try {
    const res = await deps.exec(
      "powershell",
      ["-NoProfile", "-Command", `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status`],
      { timeoutMs: 15_000 },
    );
    if (res.code !== 0) return "N/D";
    const lines = res.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const status = lines[lines.length - 1] ?? "";
    if (status === "Valid") return "Valida";
    if (status === "NotSigned") return "Non firmata";
    return status || "N/D";
  } catch {
    return "N/D";
  }
}

export async function checkRuntime(
  paths: RuntimePaths,
  deps: SyncDeps,
  options?: CheckRuntimeOptions,
): Promise<RuntimeCheck> {
  if (!(await deps.exists(paths.geniexExe))) {
    throw new Error(
      `geniex.exe non trovato in ${paths.geniexExe}: installare GenieX CLI ` +
        "prima di avviare il runtime Hexagon (il plugin non puo' allineare un vendor assente).",
    );
  }
  const genie = await deps.exec(paths.geniexExe, ["--version", "--skip-update"], {
    cwd: dirname(paths.geniexExe),
    timeoutMs: 15_000,
  });
  if (genie.code !== 0) {
    throw new Error(
      `geniex.exe --version fallito (exit ${genie.code}): ` +
        (genie.stderr.trim() || genie.stdout.trim() || "output vuoto"),
    );
  }
  const geniexHash = extractGeniexHash(`${genie.stdout}\n${genie.stderr}`);

  let llamaCommit: string | null = null;
  if (await deps.exists(paths.llamaServerExe)) {
    const llama = await deps.exec(paths.llamaServerExe, ["--version"], {
      cwd: paths.runtimeDir,
      env: { ...process.env, ADSP_LIBRARY_PATH: paths.runtimeDir },
      timeoutMs: 15_000,
    });
    if (llama.code === 0) {
      llamaCommit = extractLlamaCommit(`${llama.stdout}\n${llama.stderr}`);
    }
  }

  const missingFiles = await checkRequiredRuntimeFiles(paths.runtimeDir, deps);
  let commitAligned = sameCommit(geniexHash, llamaCommit);
  const scriptRes = await runSyncCheckScript(paths, deps, options);
  if (typeof scriptRes.commitAligned === "boolean") {
    commitAligned = scriptRes.commitAligned;
  }
  for (const f of scriptRes.missingFiles) {
    if (!missingFiles.includes(f)) missingFiles.push(f);
  }

  const hasStale = Array.isArray(scriptRes.staleFiles) && scriptRes.staleFiles.length > 0;
  return {
    geniexHash,
    llamaCommit,
    commitAligned,
    missingFiles,
    ...(scriptRes.staleFiles !== undefined ? { staleFiles: scriptRes.staleFiles } : {}),
    ...(scriptRes.serverRunning !== undefined ? { serverRunning: scriptRes.serverRunning } : {}),
    needsSync:
      !commitAligned ||
      missingFiles.length > 0 ||
      hasStale ||
      scriptRes.scriptAligned === false,
  };
}

/**
 * Ispezione non distruttiva completa dello stack runtime Hexagon (GenieX + llama-server + firma .cat).
 * A differenza di checkRuntime(), non lancia eccezioni se geniex.exe o llama-server.exe mancano:
 * espone geniexInstalled/llamaServerInstalled/allFilesAligned per diagnostica CLI (setup-kilo, launch-kilo).
 */
export async function inspectRuntimeStatus(
  paths: RuntimePaths,
  deps: SyncDeps,
  options?: CheckRuntimeOptions & { resolveFromPath?: boolean },
): Promise<RuntimeDetails> {
  let geniexExe = paths.geniexExe;
  let geniexDir = options?.geniexDir ?? dirname(paths.geniexExe);
  let geniexInstalled = await deps.exists(geniexExe);

  if (!geniexInstalled && options?.resolveFromPath !== false && process.platform === "win32") {
    try {
      const which = await deps.exec("where.exe", ["geniex.exe"], { timeoutMs: 5_000 });
      const candidate = which.code === 0 ? which.stdout.trim().split(/\r?\n/)[0]?.trim() : "";
      if (candidate && (await deps.exists(candidate))) {
        geniexExe = candidate;
        geniexDir = dirname(candidate);
        geniexInstalled = true;
      }
    } catch {
      /* geniex.exe non nel PATH */
    }
  }

  let geniexVersion = "Non rilevato";
  let qairtVersion = "N/A";
  let geniexHash: string | null = null;
  const errors: string[] = [];

  if (geniexInstalled) {
    const genie = await deps.exec(geniexExe, ["--version", "--skip-update"], {
      cwd: geniexDir,
      timeoutMs: 15_000,
    });
    if (genie.code === 0) {
      const output = `${genie.stdout}\n${genie.stderr}`;
      geniexVersion = extractLabeledField(output, "GenieX CLI Version") ?? "Non rilevato";
      qairtVersion = extractLabeledField(output, "QAIRT Runtime Version") ?? "N/A";
      geniexHash = extractGeniexHash(output);
    } else {
      geniexVersion = "Errore lettura";
      errors.push(
        `geniex.exe --version fallito (exit ${genie.code}): ${genie.stderr.trim() || genie.stdout.trim() || "output vuoto"}`,
      );
    }
  } else {
    errors.push(`geniex.exe non trovato in ${paths.geniexExe}`);
  }

  const llamaServerInstalled = await deps.exists(paths.llamaServerExe);
  let llamaServerVersion = "Non rilevato";
  let llamaCommit: string | null = null;
  if (llamaServerInstalled) {
    const llama = await deps.exec(paths.llamaServerExe, ["--version"], {
      cwd: paths.runtimeDir,
      env: { ...process.env, ADSP_LIBRARY_PATH: paths.runtimeDir },
      timeoutMs: 15_000,
    });
    if (llama.code === 0) {
      const output = `${llama.stdout}\n${llama.stderr}`;
      llamaServerVersion = extractLabeledField(output, "version") ?? "Non rilevato";
      llamaCommit = extractLlamaCommit(output);
    } else {
      llamaServerVersion = "Errore lettura";
      errors.push(`llama-server.exe --version fallito (exit ${llama.code})`);
    }
  }

  const missingFiles = await checkRequiredRuntimeFiles(paths.runtimeDir, deps);
  let commitAligned = sameCommit(geniexHash, llamaCommit);
  const scriptRes = geniexInstalled
    ? await runSyncCheckScript({ ...paths, geniexExe }, deps, { ...options, geniexDir })
    : { missingFiles: [] as string[] };

  if (typeof scriptRes.commitAligned === "boolean") {
    commitAligned = scriptRes.commitAligned;
  }
  for (const f of scriptRes.missingFiles) {
    if (!missingFiles.includes(f)) missingFiles.push(f);
  }

  const catalogSignature = await readCatalogSignature(paths.runtimeDir, deps);
  const hasStale = Array.isArray(scriptRes.staleFiles) && scriptRes.staleFiles.length > 0;
  const needsSync =
    !geniexInstalled ||
    !llamaServerInstalled ||
    !commitAligned ||
    missingFiles.length > 0 ||
    hasStale ||
    scriptRes.scriptAligned === false;
  const allFilesAligned =
    geniexInstalled &&
    llamaServerInstalled &&
    commitAligned &&
    missingFiles.length === 0 &&
    !hasStale &&
    scriptRes.scriptAligned !== false;

  return {
    geniexInstalled,
    geniexVersion,
    qairtVersion,
    geniexHash,
    llamaServerInstalled,
    llamaServerVersion,
    llamaCommit,
    commitAligned,
    allFilesAligned,
    catalogSignature,
    missingFiles,
    ...(scriptRes.staleFiles !== undefined ? { staleFiles: scriptRes.staleFiles } : {}),
    ...(scriptRes.serverRunning !== undefined ? { serverRunning: scriptRes.serverRunning } : {}),
    needsSync,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

export interface SyncScriptResult {
  message: string;
  files: string[];
  backup?: string;
}

/**
 * Risolve il percorso dello script di sincronizzazione:
 * se presente nel workspace usa quello locale, altrimenti usa la versione inclusa nel plugin.
 */
export async function resolveSyncScript(
  workspaceDir?: string,
  exists?: ExistsFn,
): Promise<string> {
  if (workspaceDir && exists) {
    const wsScript = join(workspaceDir, "sync-geniex.ps1");
    if (await exists(wsScript)) return wsScript;
  }
  return BUNDLED_SYNC_SCRIPT;
}

/**
 * Invoca il sincronizzatore core. Se non trovato nel workspaceDir,
 * ricade sul wrapper transazionale pacchettizzato negli asset del plugin.
 */
export async function runSyncScript(
  workspaceDir: string,
  paths: { binPath: string; geniexDir: string; syncScript?: string; stopServer?: boolean },
  deps: { exec: ExecFn; exists?: ExistsFn },
): Promise<SyncScriptResult> {
  const script =
    paths.syncScript ??
    (await resolveSyncScript(workspaceDir, deps.exists));
  const args = [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Apply",
    ...(paths.stopServer ? [] : ["-NoStopServer"]),
    "-Json",
    "-BinPath",
    paths.binPath,
    "-GenieXDir",
    paths.geniexDir,
  ];
  const result = await deps.exec("powershell", args, {
    cwd: dirname(script),
    timeoutMs: 900_000,
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  let parsed: { Message?: unknown; Error?: unknown; Files?: unknown; Backup?: unknown } = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    /* diagnostica PowerShell prima del JSON: nessun payload valido */
  }
  if (result.code !== 0 || typeof parsed.Error === "string") {
    throw new Error(
      `sync-geniex.ps1 fallito: ` +
        (typeof parsed.Error === "string"
          ? parsed.Error
          : result.stderr.trim() || lastLine || "output vuoto"),
    );
  }
  if (typeof parsed.Message !== "string") {
    throw new Error("Risposta del sincronizzatore non valida.");
  }
  return {
    message: parsed.Message,
    files: Array.isArray(parsed.Files) ? (parsed.Files as string[]) : [],
    backup: typeof parsed.Backup === "string" ? parsed.Backup : undefined,
  };
}

export interface EnsureRuntimeOptions {
  paths: RuntimePaths;
  workspaceDir: string;
  binPath: string;
  geniexDir: string;
  syncScript?: string;
  force?: boolean;
  stopServer?: boolean;
  beforeCheck?: RuntimeCheck;
  deps: SyncDeps;
}

/** Check -> sync se necessario -> re-check. Con force salta il check iniziale. */
export async function ensureRuntime(
  options: EnsureRuntimeOptions,
): Promise<SyncOutcome> {
  const checkOpts: CheckRuntimeOptions = {
    workspaceDir: options.workspaceDir,
    geniexDir: options.geniexDir,
    syncScript: options.syncScript,
  };
  const before =
    options.beforeCheck ??
    (await checkRuntime(options.paths, options.deps, checkOpts));
  if (!options.force && !before.needsSync) {
    return {
      updated: false,
      message: "Runtime gia' allineato al commit GenieX",
      files: [],
      check: before,
    };
  }
  const sync = await runSyncScript(
    options.workspaceDir,
    {
      binPath: options.binPath,
      geniexDir: options.geniexDir,
      syncScript: options.syncScript,
      stopServer: options.stopServer,
    },
    options.deps,
  );
  const after = await checkRuntime(options.paths, options.deps, checkOpts);
  return {
    updated: true,
    message: sync.message,
    files: sync.files,
    backup: sync.backup,
    check: after,
  };
}
