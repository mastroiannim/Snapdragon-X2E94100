import { describe, expect, it, vi } from "vitest";
import {
  checkRuntime,
  ensureRuntime,
  extractGeniexHash,
  extractLlamaCommit,
  inspectRuntimeStatus,
  resolveSyncScript,
  runSyncScript,
  sameCommit,
} from "../src/sync.js";
import { BUNDLED_SYNC_SCRIPT } from "../src/process.js";
import {
  ALL_RUNTIME_FILES,
  GENIEX_VERSION_OUTPUT,
  LLAMA_VERSION_OUTPUT,
  okExec,
  recordingExec,
} from "./helpers.js";

const PATHS = {
  geniexExe: "C:/genie/geniex.exe",
  llamaServerExe: "C:/bin/llama-server.exe",
  runtimeDir: "C:/bin",
};

function alignedDeps(overrides: { missing?: string[]; noSo?: boolean } = {}) {
  // path.join su Windows produce backslash: normalizza per il confronto.
  const norm = (path: string) => path.replace(/\\/g, "/");
  const missing = new Set((overrides.missing ?? []).map(norm));
  const exists = vi.fn(async (path: string) => {
    const clean = norm(path);
    if (clean === PATHS.geniexExe || clean === PATHS.llamaServerExe) return true;
    return !missing.has(clean);
  });
  const listDir = vi.fn(async () =>
    overrides.noSo
      ? ALL_RUNTIME_FILES.filter((name) => !name.endsWith(".so"))
      : ALL_RUNTIME_FILES,
  );
  const { fn: exec, calls } = recordingExec((call) =>
    okExec(call.command === PATHS.geniexExe ? GENIEX_VERSION_OUTPUT : LLAMA_VERSION_OUTPUT),
  );
  return { deps: { exec, exists, listDir }, calls, exists, listDir };
}

describe("extractGeniexHash", () => {
  it("estrae l'hash dalla riga LlamaCPP Runtime Hash", () => {
    expect(extractGeniexHash(GENIEX_VERSION_OUTPUT)).toBe("19cce6919");
  });
  it("restituisce null senza la riga", () => {
    expect(extractGeniexHash("GenieX CLI Version: 0.10.0")).toBeNull();
  });
});

describe("extractLlamaCommit", () => {
  it("estrae il commit tra parentesi", () => {
    expect(extractLlamaCommit("version: 11938 (19cce6919)")).toBe("19cce6919");
  });
  it("estrae il commit dopo la parola commit", () => {
    expect(extractLlamaCommit("version: b11938 commit 19cce6919")).toBe("19cce6919");
  });
  it("restituisce null senza commit", () => {
    expect(extractLlamaCommit("version: 11938")).toBeNull();
  });
});

describe("sameCommit", () => {
  it("confronta per prefisso (7-40 hex)", () => {
    expect(sameCommit("19cce6919", "19cce6919abcdef")).toBe(true);
    expect(sameCommit("ABCDEF123", "abcdef123456789")).toBe(true);
  });
  it("rifiuta hash invalidi, null e commit diversi", () => {
    expect(sameCommit(null, "19cce6919")).toBe(false);
    expect(sameCommit("19cce6919", null)).toBe(false);
    expect(sameCommit("a", "abcdef123")).toBe(false);
    expect(sameCommit("123456z", "123456z")).toBe(false);
    expect(sameCommit("19cce6919", "abcdef123")).toBe(false);
  });
});

describe("checkRuntime", () => {
  it("hash identico e file completi: nessun aggiornamento richiesto", async () => {
    const { deps } = alignedDeps();
    const check = await checkRuntime(PATHS, deps);
    expect(check.geniexHash).toBe("19cce6919");
    expect(check.llamaCommit).toBe("19cce6919");
    expect(check.commitAligned).toBe(true);
    expect(check.missingFiles).toEqual([]);
    expect(check.needsSync).toBe(false);
  });

  it("mismatch hash: needsSync true", async () => {
    const { deps } = alignedDeps();
    const exec = vi.fn(async (command: string) =>
      okExec(
        command === PATHS.geniexExe
          ? "LlamaCPP Runtime Hash: abcdef123\n"
          : LLAMA_VERSION_OUTPUT,
      ),
    );
    const check = await checkRuntime(PATHS, { ...deps, exec });
    expect(check.commitAligned).toBe(false);
    expect(check.needsSync).toBe(true);
  });

  it("file NPU mancanti elencati, incluso il pattern libggml-htp-v*.so", async () => {
    const { deps } = alignedDeps({
      missing: ["C:/bin/ggml-hexagon.dll", "C:/bin/libggml-htp.cat"],
      noSo: true,
    });
    const check = await checkRuntime(PATHS, deps);
    expect(check.missingFiles).toEqual([
      "ggml-hexagon.dll",
      "libggml-htp.cat",
      "libggml-htp-v*.so",
    ]);
    expect(check.needsSync).toBe(true);
  });

  it("geniex.exe assente: errore descrittivo", async () => {
    const { deps } = alignedDeps();
    const exists = vi.fn(async (path: string) => path !== PATHS.geniexExe);
    await expect(checkRuntime(PATHS, { ...deps, exists })).rejects.toThrow(
      /geniex\.exe non trovato/,
    );
  });

  it("geniex --version fallito: errore con exit code", async () => {
    const { deps } = alignedDeps();
    const exec = vi.fn(async () => ({ code: 3, stdout: "", stderr: "vendor rotto" }));
    await expect(checkRuntime(PATHS, { ...deps, exec })).rejects.toThrow(
      /exit 3.*vendor rotto/,
    );
  });

  it("llama-server assente: commit null e needsSync", async () => {
    const { deps } = alignedDeps();
    const exists = vi.fn(async (path: string) => path !== PATHS.llamaServerExe);
    const check = await checkRuntime(PATHS, { ...deps, exists });
    expect(check.llamaCommit).toBeNull();
    expect(check.needsSync).toBe(true);
  });

  it("llama-server --version fallito non produce commit", async () => {
    const { deps } = alignedDeps();
    const exec = vi.fn(async (command: string) =>
      command === PATHS.geniexExe
        ? okExec(GENIEX_VERSION_OUTPUT)
        : { code: 1, stdout: "", stderr: "crash" },
    );
    const check = await checkRuntime(PATHS, { ...deps, exec });
    expect(check.llamaCommit).toBeNull();
  });

  it("directory runtime illeggibile: .so mancante senza crash", async () => {
    const { deps } = alignedDeps();
    const listDir = vi.fn(async () => {
      throw new Error("ENOENT");
    });
    const check = await checkRuntime(PATHS, { ...deps, listDir });
    expect(check.missingFiles).toContain("libggml-htp-v*.so");
  });

  it("llama-server --version riceve ADSP_LIBRARY_PATH", async () => {
    const { deps, calls } = alignedDeps();
    await checkRuntime(PATHS, deps);
    const llamaCall = calls.find((call) => call.command === PATHS.llamaServerExe);
    expect(llamaCall?.options?.env?.ADSP_LIBRARY_PATH).toBe(PATHS.runtimeDir);
  });
});

describe("runSyncScript", () => {
  const workspace = "C:/repo";
  const paths = { binPath: "C:/bin", geniexDir: "C:/genie" };

  it("invoca sync-geniex.ps1 con -Apply -NoStopServer -Json e legge l'ultima riga JSON", async () => {
    const { fn: exec, calls } = recordingExec(() =>
      okExec('diagnostica PowerShell\n{"Message":"allineato","Files":["ggml.dll"],"Backup":"prev"}'),
    );
    const result = await runSyncScript(workspace, paths, { exec });
    expect(result).toEqual({
      message: "allineato",
      files: ["ggml.dll"],
      backup: "prev",
    });
    const call = calls[0];
    expect(call.command).toBe("powershell");
    expect(call.args).toContain("-Apply");
    expect(call.args).toContain("-NoStopServer");
    expect(call.args).toContain("-Json");
    expect(call.args[call.args.indexOf("-File") + 1]).toBe(BUNDLED_SYNC_SCRIPT);
    expect(call.args[call.args.indexOf("-BinPath") + 1]).toBe("C:/bin");
    expect(call.args[call.args.indexOf("-GenieXDir") + 1]).toBe("C:/genie");
  });

  it("resolveSyncScript: usa script del workspace se presente, altrimenti fallback bundled", async () => {
    const exists = vi.fn(async (p: string) => p.includes("custom-ws"));
    expect(await resolveSyncScript("C:/custom-ws", exists)).toBe("C:\\custom-ws\\sync-geniex.ps1");
    expect(await resolveSyncScript("C:/nonexistent", async () => false)).toBe(BUNDLED_SYNC_SCRIPT);
    expect(await resolveSyncScript(undefined)).toBe(BUNDLED_SYNC_SCRIPT);
  });

  it("exit non-zero con payload Error: errore propagato", async () => {
    const { fn: exec } = recordingExec(() => ({
      code: 1,
      stdout: '{"Error":"GenieX mancante"}',
      stderr: "",
    }));
    await expect(runSyncScript(workspace, paths, { exec })).rejects.toThrow(
      /GenieX mancante/,
    );
  });

  it("payload Error con exit 0: comunque fallito", async () => {
    const { fn: exec } = recordingExec(() => okExec('{"Error":"vendor assente"}'));
    await expect(runSyncScript(workspace, paths, { exec })).rejects.toThrow(
      /vendor assente/,
    );
  });

  it("JSON senza Message: risposta non valida", async () => {
    const { fn: exec } = recordingExec(() => okExec('{"Files":[]}'));
    await expect(runSyncScript(workspace, paths, { exec })).rejects.toThrow(
      /Risposta del sincronizzatore non valida/,
    );
  });

  it("output non JSON: errore con stderr", async () => {
    const { fn: exec } = recordingExec(() => ({
      code: 1,
      stdout: "testo libero",
      stderr: "errore grave",
    }));
    await expect(runSyncScript(workspace, paths, { exec })).rejects.toThrow(
      /errore grave/,
    );
  });

  it("Files non array e Backup assente: default sicuri", async () => {
    const { fn: exec } = recordingExec(() =>
      okExec('{"Message":"ok","Files":"non-array"}'),
    );
    const result = await runSyncScript(workspace, paths, { exec });
    expect(result.files).toEqual([]);
    expect(result.backup).toBeUndefined();
  });
});

describe("ensureRuntime", () => {
  const options = {
    paths: PATHS,
    workspaceDir: "C:/repo",
    binPath: "C:/bin",
    geniexDir: "C:/genie",
  };

  it("runtime allineato: nessun sync -Apply invocato", async () => {
    const { deps, calls } = alignedDeps();
    const outcome = await ensureRuntime({ ...options, deps });
    expect(outcome.updated).toBe(false);
    expect(outcome.check.needsSync).toBe(false);
    expect(
      calls.some((call) => call.command === "powershell" && call.args.includes("-Apply")),
    ).toBe(false);
  });

  it("commit allineato ma DLL stale da -CheckOnly: trigger sync con stopServer", async () => {
    let synced = false;
    const exists = vi.fn(async () => true);
    const listDir = vi.fn(async () => ALL_RUNTIME_FILES);
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell" && call.args.includes("-CheckOnly")) {
        return okExec(
          synced
            ? '{"Aligned":true,"CommitAligned":true,"MissingFiles":[],"StaleFiles":[],"ServerRunning":true}'
            : '{"Aligned":false,"CommitAligned":true,"MissingFiles":[],"StaleFiles":["ggml-hexagon.dll"],"ServerRunning":true}',
        );
      }
      if (call.command === "powershell" && call.args.includes("-Apply")) {
        synced = true;
        return okExec('{"Message":"DLL aggiornate","Files":["ggml-hexagon.dll"]}');
      }
      if (call.command === PATHS.geniexExe) {
        return okExec("LlamaCPP Runtime Hash: 19cce6919\n");
      }
      return okExec("version: 11938 (19cce6919)");
    });
    const outcome = await ensureRuntime({
      ...options,
      stopServer: true,
      deps: { exec, exists, listDir },
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.check.needsSync).toBe(false);
    const applyCall = calls.find(
      (call) => call.command === "powershell" && call.args.includes("-Apply"),
    );
    expect(applyCall).toBeDefined();
    expect(applyCall?.args).not.toContain("-NoStopServer");
  });

  it("mismatch: trigger sync-geniex.ps1 e re-check", async () => {
    let synced = false;
    const exists = vi.fn(async () => true);
    const listDir = vi.fn(async () => ALL_RUNTIME_FILES);
    const { fn: exec, calls } = recordingExec((call) => {
      if (call.command === "powershell") {
        synced = true;
        return okExec('{"Message":"runtime sostituito","Files":["ggml-hexagon.dll"]}');
      }
      if (call.command === PATHS.geniexExe) {
        return okExec("LlamaCPP Runtime Hash: 19cce6919\n");
      }
      return okExec(
        synced ? "version: 11938 (19cce6919)" : "version: 11000 (aaaaaaa)",
      );
    });
    const outcome = await ensureRuntime({
      ...options,
      deps: { exec, exists, listDir },
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.message).toBe("runtime sostituito");
    expect(outcome.files).toEqual(["ggml-hexagon.dll"]);
    expect(outcome.check.commitAligned).toBe(true);
    expect(calls.some((call) => call.command === "powershell")).toBe(true);
  });

  it("force: sync anche se allineato", async () => {
    const { deps } = alignedDeps();
    const exec = vi.fn(async (command: string) => {
      if (command === "powershell") {
        return okExec('{"Message":"forzato","Files":[]}');
      }
      return okExec(
        command === PATHS.geniexExe ? GENIEX_VERSION_OUTPUT : LLAMA_VERSION_OUTPUT,
      );
    });
    const outcome = await ensureRuntime({
      ...options,
      force: true,
      deps: { ...deps, exec },
    });
    expect(outcome.updated).toBe(true);
    expect(outcome.message).toBe("forzato");
    expect(exec.mock.calls.some(([command]) => command === "powershell")).toBe(true);
  });
});

describe("inspectRuntimeStatus", () => {
  it("restituisce dettagli completi su runtime allineato inclusa firma .cat", async () => {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const exists = vi.fn(async () => true);
    const listDir = vi.fn(async () => ALL_RUNTIME_FILES);
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "powershell") {
        if (call.args.includes("-CheckOnly")) {
          return okExec(
            '{"Aligned":true,"CommitAligned":true,"MissingFiles":[],"StaleFiles":[],"ServerRunning":true}',
          );
        }
        return okExec("Valid\n");
      }
      if (norm(call.command).endsWith("geniex.exe")) {
        return okExec(GENIEX_VERSION_OUTPUT);
      }
      return okExec(LLAMA_VERSION_OUTPUT);
    });

    const details = await inspectRuntimeStatus(
      PATHS,
      { exec, exists, listDir },
      { geniexDir: "C:/genie" },
    );
    expect(details.geniexInstalled).toBe(true);
    expect(details.geniexVersion).toBe("0.10.0");
    expect(details.qairtVersion).toBe("2.50");
    expect(details.llamaServerInstalled).toBe(true);
    expect(details.llamaServerVersion).toBe("11938 (19cce6919)");
    expect(details.commitAligned).toBe(true);
    expect(details.allFilesAligned).toBe(true);
    expect(details.catalogSignature).toBe(process.platform === "win32" ? "Valida" : "N/D");
    expect(details.needsSync).toBe(false);
  });

  it("gestisce geniex.exe assente senza lanciare eccezioni e risolve fallback PATH", async () => {
    const exists = vi.fn(async (p: string) => p.replace(/\\/g, "/") === "C:/path/geniex.exe");
    const listDir = vi.fn(async () => []);
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "where.exe") {
        return okExec("C:\\path\\geniex.exe\n");
      }
      if (call.command.includes("geniex.exe")) {
        return okExec(GENIEX_VERSION_OUTPUT);
      }
      return { code: 1, stdout: "", stderr: "" };
    });

    const resolved = await inspectRuntimeStatus(PATHS, { exec, exists, listDir });
    expect(resolved.geniexInstalled).toBe(process.platform === "win32");
    expect(resolved.llamaServerInstalled).toBe(false);
    expect(resolved.allFilesAligned).toBe(false);

    const missingAll = await inspectRuntimeStatus(
      PATHS,
      {
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        exists: async () => false,
        listDir: async () => [],
      },
      { resolveFromPath: false },
    );
    expect(missingAll.geniexInstalled).toBe(false);
    expect(missingAll.geniexVersion).toBe("Non rilevato");
    expect(missingAll.needsSync).toBe(true);
    expect(missingAll.error).toContain("geniex.exe non trovato");
  });

  it("gestisce errori di lettura version e firma NotSigned", async () => {
    const exists = vi.fn(async () => true);
    const listDir = vi.fn(async () => ALL_RUNTIME_FILES);
    const { fn: exec } = recordingExec((call) => {
      if (call.command === "powershell") {
        if (call.args.includes("-CheckOnly")) {
          return okExec('{"Aligned":false,"CommitAligned":false,"MissingFiles":["x.dll"]}');
        }
        return okExec("NotSigned\n");
      }
      return { code: 2, stdout: "", stderr: "errore eseguibile" };
    });

    const details = await inspectRuntimeStatus(
      PATHS,
      { exec, exists, listDir },
      { geniexDir: "C:/genie" },
    );
    expect(details.geniexVersion).toBe("Errore lettura");
    expect(details.llamaServerVersion).toBe("Errore lettura");
    expect(details.allFilesAligned).toBe(false);
    expect(details.missingFiles).toContain("x.dll");
    expect(details.catalogSignature).toBe(process.platform === "win32" ? "Non firmata" : "N/D");
    expect(details.error).toContain("geniex.exe --version fallito");
  });

  it("copre edge case catalogSignature, where.exe fallback fallito e output vuoti", async () => {
    const exists = vi.fn(async (p: string) => p.replace(/\\/g, "/").endsWith("libggml-htp.cat") || p.replace(/\\/g, "/") === PATHS.geniexExe);
    const { fn: execUnknown } = recordingExec((call) => {
      if (call.command === "powershell") return okExec("UnknownError\n");
      return okExec("output senza campi");
    });
    const d1 = await inspectRuntimeStatus(PATHS, { exec: execUnknown, exists, listDir: async () => [] });
    expect(d1.geniexVersion).toBe("Non rilevato");
    expect(d1.qairtVersion).toBe("N/A");
    expect(d1.catalogSignature).toBe(process.platform === "win32" ? "UnknownError" : "N/D");

    const { fn: execThrow } = recordingExec(async (call) => {
      if (call.command === "powershell") throw new Error("ps broken");
      if (call.command === "where.exe") throw new Error("where broken");
      return { code: 1, stdout: "", stderr: "" };
    });
    const d2 = await inspectRuntimeStatus(
      PATHS,
      { exec: execThrow, exists: async (p) => p.replace(/\\/g, "/").endsWith("libggml-htp.cat"), listDir: async () => [] },
    );
    expect(d2.catalogSignature).toBe("N/D");
    expect(d2.geniexInstalled).toBe(false);

    const { fn: execEmpty } = recordingExec((call) => {
      if (call.command === "powershell") return { code: 1, stdout: "", stderr: "fail" };
      if (call.command === "where.exe") return okExec("");
      return { code: 1, stdout: "out-only", stderr: "" };
    });
    const d3 = await inspectRuntimeStatus(
      PATHS,
      { exec: execEmpty, exists: async (p) => p.replace(/\\/g, "/").endsWith("libggml-htp.cat") || p.replace(/\\/g, "/") === PATHS.geniexExe, listDir: async () => [] },
    );
    expect(d3.catalogSignature).toBe("N/D");
    expect(d3.error).toContain("out-only");

    const d4 = await inspectRuntimeStatus(
      PATHS,
      {
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        exists: async (p) => p.replace(/\\/g, "/") === PATHS.geniexExe,
        listDir: async () => [],
      },
      { resolveFromPath: false },
    );
    expect(d4.error).toContain("output vuoto");
  });
});
