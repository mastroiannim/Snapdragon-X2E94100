#!/usr/bin/env node
/**
 * cli.ts — Utility CLI per @hexagon/kilo-plugin.
 *
 * Esegue il setup e l'allineamento della configurazione Kilo Code senza dipendere da Python.
 * Uso:
 *   node dist/cli.js setup [--workspace] [--global]
 */
import { installProviderConfig } from "./config.js";

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
    process.exit(0);
  }

  console.log(`Comando sconosciuto: ${command}. Comandi disponibili: setup`);
  process.exit(1);
}

void main().catch((err) => {
  console.error("[hexagon-plugin] Errore CLI:", err);
  process.exit(1);
});
