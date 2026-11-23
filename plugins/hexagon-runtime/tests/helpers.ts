/** Fake e registratori condivisi: nessun tocco reale a OS/subprocess/HTTP. */
import type {
  ExecFn,
  ExecOptions,
  ExecResult,
  FetchFn,
  HttpResponse,
  SpawnFn,
  SpawnOptions,
  WriteFileFn,
} from "../src/types.js";

export function fakeResponse(status: number, body?: unknown): HttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body ?? ""),
  };
}

/** Risposta con shape llama-server riconosciuta da probeRouter. */
export function routerResponse(url: string, status = 200): HttpResponse {
  return url.endsWith("/health")
    ? fakeResponse(status, { status: "ok" })
    : fakeResponse(status, { object: "list", data: [] });
}

export function recordingWriteFile() {
  const calls: Array<{ path: string; content: string }> = [];
  const fn: WriteFileFn = async (path, content) => {
    calls.push({ path, content });
  };
  return { fn, calls };
}

export interface ExecCall {
  command: string;
  args: string[];
  options?: ExecOptions;
}

export function recordingExec(
  handler: (call: ExecCall) => ExecResult | Promise<ExecResult>,
) {
  const calls: ExecCall[] = [];
  const fn: ExecFn = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  };
  return { fn, calls };
}

export function okExec(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr };
}

export interface SpawnCall {
  command: string;
  args: string[];
  options?: SpawnOptions;
}

export function recordingSpawn(pid?: number) {
  const calls: SpawnCall[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { pid };
  };
  return { fn, calls };
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

export function recordingFetch(
  handler: (call: FetchCall) => HttpResponse | Promise<HttpResponse>,
) {
  const calls: FetchCall[] = [];
  const fn: FetchFn = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fn, calls };
}

/** Versioni fixture allineate, identiche al formato reale degli EXE. */
export const GENIEX_VERSION_OUTPUT =
  "GenieX CLI Version: 0.10.0\nQAIRT Runtime Version: 2.50\nLlamaCPP Runtime Hash: 19cce6919\n";
export const LLAMA_VERSION_OUTPUT = "version: 11938 (19cce6919)\n";

export const ALL_RUNTIME_FILES = [
  "ggml.dll",
  "ggml-hexagon.dll",
  "ggml-opencl.dll",
  "libggml-htp-v81.so",
  "libggml-htp.cat",
  "llama-server.exe",
];
