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
  needsSync: boolean;
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

/** I commit sono confrontati per prefisso (7-40 hex), come nel core Python. */
export function sameCommit(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const hex = /^[0-9a-f]{7,40}$/i;
  if (!hex.test(left) || !hex.test(right)) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

export async function checkRuntime(
  paths: RuntimePaths,
  deps: SyncDeps,
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

  const missingFiles: string[] = [];
  for (const name of REQUIRED_RUNTIME_FILES) {
    if (!(await deps.exists(join(paths.runtimeDir, name)))) {
      missingFiles.push(name);
    }
  }
  let hasHtpSo = false;
  try {
    hasHtpSo = (await deps.listDir(paths.runtimeDir)).some((name) =>
      HTP_SO_PATTERN.test(name),
    );
  } catch {
    /* directory runtime assente: il file .so risulta mancante */
  }
  if (!hasHtpSo) missingFiles.push("libggml-htp-v*.so");

  const commitAligned = sameCommit(geniexHash, llamaCommit);
  return {
    geniexHash,
    llamaCommit,
    commitAligned,
    missingFiles,
    needsSync: !commitAligned || missingFiles.length > 0,
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
  paths: { binPath: string; geniexDir: string; syncScript?: string },
  deps: { exec: ExecFn; exists?: ExistsFn },
): Promise<SyncScriptResult> {
  const script =
    paths.syncScript ??
    (await resolveSyncScript(workspaceDir, deps.exists));
  const result = await deps.exec(
    "powershell",
    [
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Apply",
      "-NoStopServer",
      "-Json",
      "-BinPath",
      paths.binPath,
      "-GenieXDir",
      paths.geniexDir,
    ],
    { cwd: dirname(script), timeoutMs: 900_000 },
  );
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
  deps: SyncDeps;
}

/** Check -> sync se necessario -> re-check. Con force salta il check iniziale. */
export async function ensureRuntime(
  options: EnsureRuntimeOptions,
): Promise<SyncOutcome> {
  const before = await checkRuntime(options.paths, options.deps);
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
    { binPath: options.binPath, geniexDir: options.geniexDir, syncScript: options.syncScript },
    options.deps,
  );
  const after = await checkRuntime(options.paths, options.deps);
  return {
    updated: true,
    message: sync.message,
    files: sync.files,
    backup: sync.backup,
    check: after,
  };
}
