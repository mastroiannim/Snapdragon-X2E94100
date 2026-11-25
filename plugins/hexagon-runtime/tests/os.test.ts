import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

import { execFile, spawn } from "node:child_process";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  nodeDeps,
  nodeExec,
  nodeExists,
  nodeFetch,
  nodeIsDirectory,
  nodeListDir,
  nodeNow,
  nodeReadFile,
  nodeSleep,
  nodeSpawn,
  nodeWriteFile,
} from "../src/os.js";
import { fakeResponse } from "./helpers.js";

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);
const accessMock = vi.mocked(access);
const readdirMock = vi.mocked(readdir);
const readFileMock = vi.mocked(readFile);
const statMock = vi.mocked(stat);
const writeFileMock = vi.mocked(writeFile);

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("nodeExec", () => {
  it("successo: stdout/stderr preservati e opzioni inoltrate", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (e: unknown, out: string, err: string) => void)(null, "out", "err");
      return {} as never;
    });
    const result = await nodeExec("geniex.exe", ["--version"], {
      cwd: "C:/genie",
      env: { A: "B" },
      timeoutMs: 5000,
    });
    expect(result).toEqual({ code: 0, stdout: "out", stderr: "err" });
    const options = execFileMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.cwd).toBe("C:/genie");
    expect(options.env).toEqual({ A: "B" });
    expect(options.timeout).toBe(5000);
    expect(options.windowsHide).toBe(true);
    expect(options.maxBuffer).toBe(16 * 1024 * 1024);
  });

  it("timeout default 60s senza timeoutMs", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (e: unknown, out: string, err: string) => void)(null, "", "");
      return {} as never;
    });
    await nodeExec("x", []);
    const options = execFileMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.timeout).toBe(60_000);
  });

  it("exit code numerico dell'errore preservato", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (e: unknown, out: string, err: string) => void)(
        { code: 7 },
        "",
        "boom",
      );
      return {} as never;
    });
    const result = await nodeExec("x", []);
    expect(result.code).toBe(7);
    expect(result.stderr).toBe("boom");
  });

  it("errore di sistema (code stringa): exit 1 e output vuoti normalizzati", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (e: unknown, out: unknown, err: unknown) => void)(
        { code: "ENOENT" },
        null,
        null,
      );
      return {} as never;
    });
    const result = await nodeExec("x", []);
    expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
  });
});

describe("nodeSpawn", () => {
  it("distaccato, stdio ignore, unref e pid esposto", () => {
    const unref = vi.fn();
    spawnMock.mockReturnValue({ pid: 99, unref } as never);
    const result = nodeSpawn("llama-server.exe", ["--port", "18803"], {
      cwd: "C:/bin",
      env: { ADSP_LIBRARY_PATH: "C:/bin" },
    });
    expect(result.pid).toBe(99);
    expect(unref).toHaveBeenCalled();
    const options = spawnMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.cwd).toBe("C:/bin");
  });

  it("detached override esplicito", () => {
    spawnMock.mockReturnValue({ pid: undefined, unref: vi.fn() } as never);
    nodeSpawn("x", [], { detached: false });
    const options = spawnMock.mock.calls[0][2] as Record<string, unknown>;
    expect(options.detached).toBe(false);
  });
});

describe("nodeReadFile / nodeExists / nodeListDir", () => {
  it("readFile in utf8", async () => {
    readFileMock.mockResolvedValue("contenuto" as never);
    expect(await nodeReadFile("C:/x.ini")).toBe("contenuto");
    expect(readFileMock).toHaveBeenCalledWith("C:/x.ini", "utf8");
  });

  it("writeFile in utf8", async () => {
    writeFileMock.mockResolvedValue(undefined as never);
    await nodeWriteFile("C:/x.ini", "[*]\nthreads = 12\n");
    expect(writeFileMock).toHaveBeenCalledWith(
      "C:/x.ini",
      "[*]\nthreads = 12\n",
      "utf8",
    );
  });

  it("exists: true su access riuscito, false su errore", async () => {
    accessMock.mockResolvedValue(undefined as never);
    expect(await nodeExists("C:/x")).toBe(true);
    accessMock.mockRejectedValue(new Error("ENOENT") as never);
    expect(await nodeExists("C:/x")).toBe(false);
  });

  it("listDir inoltra readdir", async () => {
    readdirMock.mockResolvedValue(["a.dll", "b.so"] as never);
    expect(await nodeListDir("C:/bin")).toEqual(["a.dll", "b.so"]);
  });

  it("isDirectory verifica stat e ritorna false su errore", async () => {
    statMock.mockResolvedValue({ isDirectory: () => true } as never);
    expect(await nodeIsDirectory("C:/models/sub")).toBe(true);
    statMock.mockResolvedValue({ isDirectory: () => false } as never);
    expect(await nodeIsDirectory("C:/models/a.gguf")).toBe(false);
    statMock.mockRejectedValue(new Error("ENOENT") as never);
    expect(await nodeIsDirectory("C:/missing")).toBe(false);
  });
});

describe("nodeFetch / nodeSleep / nodeNow", () => {
  it("fetch globale inoltrato con init", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200));
    vi.stubGlobal("fetch", fetchMock);
    const response = await nodeFetch("http://127.0.0.1:18803/health", {
      method: "GET",
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18803/health", {
      method: "GET",
    });
  });

  it("sleep risolve dopo l'intervallo richiesto", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = nodeSleep(1000).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it("now usa Date.now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    expect(nodeNow()).toBe(Date.now());
  });
});

describe("nodeDeps", () => {
  it("espone il fascio completo degli adapter", () => {
    expect(nodeDeps.exec).toBe(nodeExec);
    expect(nodeDeps.spawn).toBe(nodeSpawn);
    expect(nodeDeps.fetch).toBe(nodeFetch);
    expect(nodeDeps.readFile).toBe(nodeReadFile);
    expect(nodeDeps.writeFile).toBe(nodeWriteFile);
    expect(nodeDeps.exists).toBe(nodeExists);
    expect(nodeDeps.listDir).toBe(nodeListDir);
    expect(nodeDeps.sleep).toBe(nodeSleep);
    expect(nodeDeps.now).toBe(nodeNow);
  });
});
