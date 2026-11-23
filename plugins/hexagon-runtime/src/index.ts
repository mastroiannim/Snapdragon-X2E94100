/**
 * index.ts — Plugin Kilo nativo per il runtime Hexagon (Snapdragon X2 Elite).
 *
 * Default export conforme al contratto @kilocode/plugin v1:
 *   Plugin = (input: PluginInput) => Promise<Hooks>
 * Il descrittore { id, server } richiesto dal piano di pivot e' esposto come
 * export nominale per introspection e test.
 *
 * Hook:
 * - event/session.created: bootstrap del server locale (sync -> avvio -> health);
 * - chat.params: reasoning_effort "none" sui modelli locali (tool-calling deterministico);
 * - tool: hexagon_status, hexagon_sync, hexagon_bench.
 */
import type { Hooks, Plugin } from "@kilocode/plugin";
import { waitForHealth, type HealthResult } from "./health.js";
import { isLocalModel } from "./models.js";
import { nodeDeps } from "./os.js";
import {
  defaultPaths,
  ensureServer,
  type EnsureServerResult,
} from "./process.js";
import { ensureRuntime, type SyncOutcome } from "./sync.js";
import { createHexagonTools } from "./tools.js";
import type { OsDeps } from "./types.js";

export interface BootstrapResult {
  sync: SyncOutcome;
  server: EnsureServerResult;
  health: HealthResult;
}

export interface RuntimeOptions {
  workspaceDir: string;
  deps?: Partial<OsDeps>;
}

/**
 * Bootstrap completo: allinea il runtime al commit GenieX, avvia llama-server
 * solo se la porta router e' libera, attende la readiness HTTP (warm-up HTP).
 */
export async function bootstrapRuntime(
  options: RuntimeOptions,
): Promise<BootstrapResult> {
  const deps: OsDeps = { ...nodeDeps, ...options.deps };
  const paths = defaultPaths(options.workspaceDir);
  const sync = await ensureRuntime({
    paths: {
      geniexExe: paths.geniexExe,
      llamaServerExe: paths.serverExe,
      runtimeDir: paths.binPath,
    },
    workspaceDir: paths.workspaceDir,
    binPath: paths.binPath,
    geniexDir: paths.geniexDir,
    deps,
  });
  const server = await ensureServer({
    fetch: deps.fetch,
    spawn: deps.spawn,
    runtimeDir: paths.binPath,
    serverExe: paths.serverExe,
    iniPath: paths.iniPath,
    modelsDir: paths.modelsDir,
  });
  const health = await waitForHealth({ fetch: deps.fetch, sleep: deps.sleep, now: deps.now });
  return { sync, server, health };
}

export interface HookOptions extends RuntimeOptions {
  /** Override iniettabile del bootstrap (test del hook session.created). */
  bootstrap?: () => Promise<unknown>;
}

export function createHexagonHooks(options: HookOptions): Hooks {
  const workspaceDir = options.workspaceDir || process.cwd();
  const deps: OsDeps = { ...nodeDeps, ...options.deps };
  const paths = defaultPaths(workspaceDir);
  const bootstrap =
    options.bootstrap ?? (() => bootstrapRuntime({ ...options, workspaceDir }));

  const event: NonNullable<Hooks["event"]> = async ({ event }) => {
    if (event.type === "session.created") {
      // Fire-and-forget: il warm-up NPU (fino a 30 s) non deve bloccare la sessione.
      void bootstrap().catch((error: unknown) => {
        console.error("[hexagon-runtime] bootstrap runtime fallito:", error);
      });
    }
  };

  const chatParams: NonNullable<Hooks["chat.params"]> = async (input, output) => {
    if (isLocalModel(input.model.providerID)) {
      // Tool-calling deterministico sui modelli locali: niente reasoning libero.
      output.options.reasoning_effort = "none";
    }
  };

  return {
    event,
    "chat.params": chatParams,
    tool: createHexagonTools({
      fetch: deps.fetch,
      exec: deps.exec,
      readFile: deps.readFile,
      workspaceDir: paths.workspaceDir,
      sync: ({ force } = {}) =>
        ensureRuntime({
          paths: {
            geniexExe: paths.geniexExe,
            llamaServerExe: paths.serverExe,
            runtimeDir: paths.binPath,
          },
          workspaceDir: paths.workspaceDir,
          binPath: paths.binPath,
          geniexDir: paths.geniexDir,
          force,
          deps,
        }),
    }),
  };
}

/** Ingresso del plugin per il loader Kilo. */
export const pluginInit: Plugin = async (input) => {
  const workspaceDir =
    (input && (input.worktree || input.directory)) || process.cwd();
  return createHexagonHooks({ workspaceDir });
};

/** Descrittore stabile richiesto dal piano di pivot (introspection/test). */
export const plugin = { id: "hexagon-runtime", server: pluginInit } as const;

export default pluginInit;

export { createHexagonTools } from "./tools.js";

