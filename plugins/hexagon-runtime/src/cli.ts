#!/usr/bin/env node
/**
 * cli.ts — Utility CLI nativa TypeScript per @hexagon/kilo-plugin.
 *
 * Gestisce configurazione Kilo, sync modelli/runtime, stato e validazione offline.
 * Uso:
 *   node dist/cli.js setup [--workspace [dir]] [--global] [--port 18803] [--host 127.0.0.1] [--models-dir dir] [--ini path] [--main-model id] [--small-model id] [--json]
 *   node dist/cli.js sync [--workspace [dir]] [--port 18803] [--host 127.0.0.1]
 *   node dist/cli.js status [--check-runtime] [--port 18803] [--host 127.0.0.1] [--workspace [dir]]
 *   node dist/cli.js validate [--workspace [dir]] [--config path] [--json]
 */
import { join, resolve } from "node:path";
import { installProviderConfig } from "./config.js";
import {
  scanModels,
  syncDiscoveredModelsToIni,
  type DiscoveredModel,
} from "./discovery.js";
import { collectStatus } from "./health.js";
import { nodeDeps } from "./os.js";
import {
  defaultLogsDir,
  defaultPaths,
  defaultServerLogPath,
  getLoadedModels,
  reloadServerIfStale,
  ROUTER_HOST,
  ROUTER_PORT,
} from "./process.js";
import { defaultRegistryPath } from "./qualify.js";
import { inspectRuntimeStatus } from "./sync.js";
import { validateKiloConfig } from "./validate.js";

interface ParsedFlags {
  hasWorkspace: boolean;
  workspaceArg?: string;
  isGlobal: boolean;
  port?: number;
  host?: string;
  modelsDir?: string;
  iniPath?: string;
  mainModel?: string;
  smallModel?: string;
  configPath?: string;
  checkRuntime: boolean;
  json: boolean;
}

function readFlagValue(args: string[], idx: number, flag: string): string {
  const next = args[idx + 1];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`Opzione ${flag} richiede un valore.`);
  }
  return next;
}

function parseFlags(args: string[]): ParsedFlags {
  const parsed: ParsedFlags = {
    hasWorkspace: false,
    isGlobal: false,
    checkRuntime: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace") {
      parsed.hasWorkspace = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        parsed.workspaceArg = resolve(next);
        i++;
      }
    } else if (arg === "--global") {
      parsed.isGlobal = true;
    } else if (arg === "--check-runtime") {
      parsed.checkRuntime = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--port") {
      const raw = readFlagValue(args, i, "--port");
      const port = Number.parseInt(raw, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
        throw new Error(`Porta non valida '${raw}' (atteso intero 1..65535).`);
      }
      parsed.port = port;
      i++;
    } else if (arg === "--host") {
      parsed.host = readFlagValue(args, i, "--host").trim();
      if (!parsed.host) {
        throw new Error("Opzione --host non puo' essere vuota.");
      }
      i++;
    } else if (arg === "--models-dir") {
      parsed.modelsDir = resolve(readFlagValue(args, i, "--models-dir"));
      i++;
    } else if (arg === "--ini") {
      parsed.iniPath = resolve(readFlagValue(args, i, "--ini"));
      i++;
    } else if (arg === "--main-model") {
      parsed.mainModel = readFlagValue(args, i, "--main-model");
      i++;
    } else if (arg === "--small-model") {
      parsed.smallModel = readFlagValue(args, i, "--small-model");
      i++;
    } else if (arg === "--config") {
      parsed.configPath = resolve(readFlagValue(args, i, "--config"));
      i++;
    } else if (arg.startsWith("--")) {
      throw new Error(`Opzione sconosciuta: ${arg}`);
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "setup";
  const flags = parseFlags(args.slice(1));

  const workspaceDir = flags.isGlobal
    ? undefined
    : flags.hasWorkspace
      ? (flags.workspaceArg ?? process.cwd())
      : undefined;
  const activeWorkspace = flags.workspaceArg ?? process.cwd();
  const host = flags.host ?? ROUTER_HOST;
  const port = flags.port ?? ROUTER_PORT;

  if (command === "setup") {
    const paths = defaultPaths(activeWorkspace);
    const modelsDir = flags.modelsDir ?? paths.modelsDir;
    const iniPath = flags.iniPath ?? paths.iniPath;
    const registryPath = defaultRegistryPath();

    const liveModels = await getLoadedModels({
      fetch: nodeDeps.fetch,
      host,
      port,
      timeoutMs: 1_500,
    });

    let discoveredModels: DiscoveredModel[] | undefined;
    if (await nodeDeps.exists(modelsDir).catch(() => false)) {
      discoveredModels = await scanModels({
        modelsDir,
        registryPath,
        deps: nodeDeps,
        skipInspection: true,
      }).catch(() => undefined);
    }

    const result = await installProviderConfig({
      workspaceDir,
      iniPath,
      registryPath,
      host: flags.host,
      port: flags.port,
      mainModel: flags.mainModel,
      smallModel: flags.smallModel,
      liveModels,
      discoveredModels,
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `[hexagon-plugin] Provider Hexagon configurato in: ${result.targetPath} (${workspaceDir ? "workspace" : "globale"}, endpoint http://${host}:${port}/v1)`,
    );
    console.log(`[hexagon-plugin] Modelli registrati: ${result.modelCount}`);
    if (result.mainModel || result.smallModel) {
      console.log(
        `[hexagon-plugin] Preset attivi: model=${result.mainModel ?? "N/D"}, small_model=${result.smallModel ?? "N/D"} (explore/ask)`,
      );
    }
    return;
  }

  if (command === "sync") {
    console.log("[hexagon-plugin] Sincronizzazione modelli e verifica router...");
    const paths = defaultPaths(activeWorkspace);
    const res = await syncDiscoveredModelsToIni({
      modelsDir: paths.modelsDir,
      iniPath: paths.iniPath,
      workspaceDir: paths.workspaceDir,
      registryPath: defaultRegistryPath(),
      deps: nodeDeps,
    });
    console.log(`[hexagon-plugin] Modelli totali nel catalogo: ${res.totalModels}`);
    if (res.addedModels.length > 0) {
      console.log(`[hexagon-plugin] Nuovi modelli aggiunti: ${res.addedModels.join(", ")}`);
    } else {
      console.log("[hexagon-plugin] Nessun nuovo modello rilevato in .cache/geniex/models");
    }
    const reload = await reloadServerIfStale({
      fetch: nodeDeps.fetch,
      spawn: nodeDeps.spawn,
      exec: nodeDeps.exec,
      readFile: nodeDeps.readFile,
      sleep: nodeDeps.sleep,
      runtimeDir: paths.binPath,
      serverExe: paths.serverExe,
      iniPath: paths.iniPath,
      modelsDir: paths.modelsDir,
      host,
      port,
    });
    if (reload.reloaded) {
      console.log(`[hexagon-plugin] Router riavviato: ${reload.reason}`);
    } else {
      console.log(`[hexagon-plugin] Router allineato: ${reload.reason}`);
    }
    return;
  }

  if (command === "status") {
    const status = await collectStatus({
      fetch: nodeDeps.fetch,
      host,
      port,
      logPath: defaultServerLogPath(),
      logsDir: defaultLogsDir(),
      readFile: nodeDeps.readFile,
      exists: nodeDeps.exists,
      listDir: nodeDeps.listDir,
    });
    if (flags.checkRuntime) {
      const paths = defaultPaths(activeWorkspace);
      status.runtime = await inspectRuntimeStatus(
        {
          geniexExe: paths.geniexExe,
          llamaServerExe: paths.serverExe,
          runtimeDir: paths.binPath,
        },
        nodeDeps,
        {
          workspaceDir: paths.workspaceDir,
          geniexDir: paths.geniexDir,
        },
      );
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === "validate") {
    const configPath = flags.configPath ?? join(activeWorkspace, "kilo.json");
    const result = await validateKiloConfig(configPath);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.valid) {
      console.log("Configurazione kilo.json VALIDA e conforme alle regole di sicurezza offline.");
    } else {
      console.log("Errori rilevati in kilo.json:");
      for (const issue of result.issues) {
        console.log(` - ${issue}`);
      }
    }
    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }

  console.error(
    `Comando sconosciuto: ${command}. Comandi disponibili: setup, sync, status, validate`,
  );
  process.exit(1);
}

void main().catch((err) => {
  console.error("[hexagon-plugin] Errore CLI:", err instanceof Error ? err.message : err);
  process.exit(1);
});
