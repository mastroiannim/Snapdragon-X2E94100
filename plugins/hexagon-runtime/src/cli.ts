#!/usr/bin/env node
/**
 * cli.ts — Utility CLI per @hexagon/kilo-plugin.
 *
 * Esegue il setup e l'allineamento della configurazione Kilo Code senza dipendere da Python.
 * Uso:
 *   node dist/cli.js setup [--workspace] [--global]
 */
import { installProviderConfig } from "./config.js";
import { syncDiscoveredModelsToIni } from "./discovery.js";
import { nodeDeps } from "./os.js";
import { defaultPaths, reloadServerIfStale } from "./process.js";
import { collectStatus } from "./tools.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "setup";

  if (command === "setup") {
    const isWorkspace = args.includes("--workspace");
    const workspaceDir = isWorkspace ? process.cwd() : undefined;
    console.log(`[hexagon-plugin] Configurazione provider in corso (${isWorkspace ? "workspace" : "globale"})...`);
    const result = await installProviderConfig({ workspaceDir });
    console.log(`[hexagon-plugin] Provider Hexagon configurato in: ${result.targetPath}`);
    console.log(`[hexagon-plugin] Modelli registrati: ${result.modelCount}`);
    return;
  }

  if (command === "sync") {
    console.log("[hexagon-plugin] Sincronizzazione modelli e verifica router...");
    const paths = defaultPaths(process.cwd());
    const res = await syncDiscoveredModelsToIni({
      modelsDir: paths.modelsDir,
      iniPath: paths.iniPath,
      workspaceDir: paths.workspaceDir,
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
    });
    if (reload.reloaded) {
      console.log(`[hexagon-plugin] Router riavviato: ${reload.reason}`);
    } else {
      console.log(`[hexagon-plugin] Router allineato: ${reload.reason}`);
    }
    return;
  }

  if (command === "status") {
    const status = await collectStatus({ fetch: nodeDeps.fetch });
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Comando sconosciuto: ${command}. Comandi disponibili: setup, sync, status`);
  process.exit(1);
}

void main().catch((err) => {
  console.error("[hexagon-plugin] Errore CLI:", err);
  process.exit(1);
});
