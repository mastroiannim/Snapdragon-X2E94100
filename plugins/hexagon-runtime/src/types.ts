/**
 * Contratti condivisi del plugin hexagon-runtime.
 * Tutte le interazioni con OS/subprocess/HTTP passano da questi tipi,
 * cosi' la suite Vitest puo' mockare i confini senza toccare il sistema reale.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}

export interface SpawnResult {
  pid: number | undefined;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options?: SpawnOptions,
) => SpawnResult;

/** Sottoinsieme strutturale di Response: basta per health/modelli/benchmark. */
export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<HttpResponse>;

export type ReadFileFn = (path: string) => Promise<string>;
export type WriteFileFn = (path: string, content: string) => Promise<void>;
export type ExistsFn = (path: string) => Promise<boolean>;
export type IsDirFn = (path: string) => Promise<boolean>;
export type ListDirFn = (path: string) => Promise<string[]>;
export type MkdirFn = (path: string) => Promise<void> | void;
export type SleepFn = (ms: number) => Promise<void>;
export type NowFn = () => number;

/** Fascio completo delle dipendenze OS iniettabili nei moduli e nei test. */
export interface OsDeps {
  exec: ExecFn;
  spawn: SpawnFn;
  fetch: FetchFn;
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  exists: ExistsFn;
  listDir: ListDirFn;
  isDirectory?: IsDirFn;
  sleep: SleepFn;
  now: NowFn;
}
