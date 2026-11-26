/**
 * Adapter sottili verso le API Node reali. Unico punto del plugin che tocca
 * child_process/fs/promises/fetch: i test li verificano con vi.mock e il resto
 * della suite inietta fake attraverso OsDeps.
 */
import { execFile, spawn } from "node:child_process";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type {
  ExecFn,
  ExistsFn,
  FetchFn,
  IsDirFn,
  ListDirFn,
  NowFn,
  OsDeps,
  ReadFileFn,
  SleepFn,
  SpawnFn,
  WriteFileFn,
} from "./types.js";

export const nodeExec: ExecFn = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          code: exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });

export const nodeSpawn: SpawnFn = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached ?? true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid };
};

export const nodeReadFile: ReadFileFn = (path) => readFile(path, "utf8");

export const nodeWriteFile: WriteFileFn = (path, content) =>
  writeFile(path, content, "utf8");

export const nodeExists: ExistsFn = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const nodeListDir: ListDirFn = (path) => readdir(path);

export const nodeIsDirectory: IsDirFn = async (path) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

export const nodeFetch: FetchFn = (url, init) => fetch(url, init);

export const nodeSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const nodeNow: NowFn = () => Date.now();

export const nodeDeps: OsDeps = {
  exec: nodeExec,
  spawn: nodeSpawn,
  fetch: nodeFetch,
  readFile: nodeReadFile,
  writeFile: nodeWriteFile,
  exists: nodeExists,
  listDir: nodeListDir,
  isDirectory: nodeIsDirectory,
  sleep: nodeSleep,
  now: nodeNow,
};
