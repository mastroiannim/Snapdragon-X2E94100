/**
 * discovery.ts — Scansione, ispezione e classificazione euristica dei modelli GGUF locali.
 *
 * Distingue modelli CERTIFIED (profilati) da UNTESTED (sperimentali), filtra gli mmproj
 * multimodali e calcola l'allocazione hardware ottimale (HTP0/GPUOpenCL) per lo Snapdragon X2 Elite.
 */
import { basename, dirname, join } from "node:path";
import { installProviderConfig } from "./config.js";
import { TESTED_CONTEXT_WINDOWS } from "./models.js";
import { BUNDLED_INSPECT_SCRIPT, parseModelsIni } from "./process.js";
import type {
  ExecFn,
  ExistsFn,
  ListDirFn,
  ReadFileFn,
  WriteFileFn,
} from "./types.js";

export type ModelStatus = "certified" | "untested" | "incompatible";

export interface GgufMetadata {
  architecture: string;
  model_name: string;
  context_length: number;
  embedding_length: number;
  block_count: number;
  head_count: number;
  head_count_kv: number;
  expert_count: number;
  expert_used_count: number;
  sliding_window: number;
  file_type: number;
  file_size_bytes: number;
  size_gb: number;
  quant_name: string;
  is_moe: boolean;
}

export interface OptimalConfig {
  device: string;
  tensorSplit?: string;
  contextSize: number;
  strategy: string;
}

export interface DiscoveredModel {
  id: string;
  fileName: string;
  filePath: string;
  sizeGb: number;
  status: ModelStatus;
  device: string;
  tensorSplit?: string;
  contextWindow: number;
  strategy: string;
  metadata?: GgufMetadata;
  mmprojPath?: string;
}

export interface ScanDeps {
  listDir: ListDirFn;
  exists: ExistsFn;
  exec: ExecFn;
}

export interface InspectOptions {
  exec: ExecFn;
  scriptPath?: string;
}

/** Verifica se il nome file e' un artefatto proiettore multimodale. */
export function isMmprojFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith("mmproj") || lower.includes("-mmproj");
}

/**
 * Calcola l'allocazione hardware ottimale basata sui metadati GGUF
 * e sui vincoli hardware dello Snapdragon X2 Elite (limite DMA FastRPC < 1 GiB).
 */
export function calculateOptimalConfig(meta: GgufMetadata): OptimalConfig {
  if (!meta || typeof meta.architecture !== "string") {
    return {
      device: "HTP0",
      contextSize: 65_536,
      strategy: "Fallback: metadati non validi o mancanti",
    };
  }
  const size = meta.size_gb;
  const isKQuant = meta.quant_name === "K-Quants";
  const hasSwa = meta.sliding_window > 0;
  const isMoE = meta.is_moe;

  let device = "HTP0";
  let tensorSplit: string | undefined;
  let strategy = "";
  let contextSize = 65_536;

  // 1. Regole di Allocazione Hardware
  if (meta.architecture.toLowerCase().includes("lfm2")) {
    // LFM2.5 crasha (0xC0000005) se usa la GPU: forzare 100% NPU HTP0
    device = "HTP0";
    strategy = "MoE Leggero lfm2moe: 100% HTP0 (evita crash GPU 0xC0000005)";
  } else if (isMoE) {
    if (size <= 13.5) {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "80,20";
      strategy = "MoE Leggero: Ibrido HTP0 (80%) + GPU (20%) per doppio canale RAM";
    } else if (isKQuant) {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "85,15";
      strategy = "MoE Gigante K-Quants: Ibrido HTP0 (85%) + GPU (15%) per preservare SIMD NPU";
    } else {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "50,50";
      strategy = "MoE Gigante Q4_0: Ibrido 50/50 per azzerare il fallback CPU";
    }
  } else {
    // Modelli Densi
    if (size <= 6.0) {
      device = "HTP0";
      strategy = "Dense Compatto (<=6GB): 100% NPU HTP0 (prefill 750-3800 t/s)";
    } else if (size <= 13.5) {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "75,25";
      strategy = "Dense Medio: Ibrido HTP0 (75%) + GPU (25%) per sbloccare DMA a contesti lunghi";
    } else {
      // Modelli > 13.5 GB (superamento soglia FastRPC NPU)
      device = "GPUOpenCL";
      strategy = "Dense Enorme (>13.5GB): 100% GPU Adreno (previene overflow buffer FastRPC e saturazione CPU)";
    }
  }

  // 2. Calcolo Finestra di Contesto
  if (hasSwa) {
    contextSize = 131_072;
  } else if (isMoE) {
    contextSize = 65_536;
  } else if (size >= 7.0) {
    contextSize = 65_536; // Limitato a 64k per rispettare descrittore FastRPC < 1 GiB
  } else {
    contextSize = Math.min(65_536, meta.context_length > 0 ? meta.context_length : 65_536);
  }

  return { device, tensorSplit, contextSize, strategy };
}

/** Esegue inspect-gguf.ps1 ed estrae i metadati strutturati. */
export async function inspectGguf(
  filePath: string,
  options: InspectOptions,
): Promise<GgufMetadata> {
  const script = options.scriptPath ?? BUNDLED_INSPECT_SCRIPT;
  const result = await options.exec(
    "powershell",
    ["-ExecutionPolicy", "Bypass", "-File", script, "-Path", filePath, "-Json"],
    { cwd: dirname(script), timeoutMs: 30_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `Ispezione GGUF fallita su ${basename(filePath)} (exit ${result.code}): ` +
        (result.stderr.trim() || result.stdout.trim() || "errore sconosciuto"),
    );
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "{}";
  const parsed = JSON.parse(lastLine) as GgufMetadata & { Error?: string };
  if (typeof parsed.Error === "string") {
    throw new Error(`Errore GGUF: ${parsed.Error}`);
  }
  return parsed;
}

export interface ScanOptions {
  modelsDir: string;
  deps: ScanDeps;
  certifiedIds?: Set<string>;
  inspectScript?: string;
  skipInspection?: boolean;
}

/**
 * Scansiona la directory modelli, separa i file mmproj, rileva i modelli
 * e calcola lo stato di certificazione e l'allocazione hardware.
 */
export async function scanModels(options: ScanOptions): Promise<DiscoveredModel[]> {
  const { modelsDir, deps } = options;
  if (!(await deps.exists(modelsDir))) {
    return [];
  }

  const allFiles = await deps.listDir(modelsDir);
  const ggufFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".gguf"));

  // Separa proiettori multimodali
  const mmprojMap = new Map<string, string>();
  const modelFiles: string[] = [];

  for (const file of ggufFiles) {
    if (isMmprojFile(file)) {
      const full = join(modelsDir, file);
      mmprojMap.set(file.toLowerCase(), full);
    } else {
      modelFiles.push(file);
    }
  }

  const certifiedSet = options.certifiedIds ?? new Set(Object.keys(TESTED_CONTEXT_WINDOWS));
  const models: DiscoveredModel[] = [];

  for (const fileName of modelFiles) {
    const filePath = join(modelsDir, fileName);
    const id = fileName.replace(/\.gguf$/i, "");
    const isCertified = certifiedSet.has(id);

    // Cerca mmproj candidato associabile (per ID completo o nome base senza quant)
    let mmprojPath: string | undefined;
    const idLower = id.toLowerCase();
    const baseName = idLower.replace(/[-_]?(?:q\d[a-z0-9_]*|f16|bf16|f32)$/i, "");

    const candidates = [
      `mmproj-${idLower}-f16.gguf`,
      `mmproj-${idLower}-bf16.gguf`,
      `mmproj-${idLower}.gguf`,
      `${idLower}-mmproj.gguf`,
      `mmproj-${baseName}-f16.gguf`,
      `mmproj-${baseName}-bf16.gguf`,
      `mmproj-${baseName}.gguf`,
      `${baseName}-mmproj.gguf`,
    ];
    for (const cand of candidates) {
      const match = mmprojMap.get(cand);
      if (match) {
        mmprojPath = match;
        break;
      }
    }
    if (!mmprojPath && baseName) {
      for (const [mmKey, mmVal] of mmprojMap.entries()) {
        if (mmKey.startsWith(`mmproj-${baseName}`) || mmKey.includes(baseName)) {
          mmprojPath = mmVal;
          break;
        }
      }
    }

    let meta: GgufMetadata | undefined;
    let config: OptimalConfig;

    if (!options.skipInspection) {
      try {
        meta = await inspectGguf(filePath, {
          exec: deps.exec,
          scriptPath: options.inspectScript,
        });
        config = calculateOptimalConfig(meta);
      } catch {
        // Fallback prudente se l'ispezione fallisce
        config = {
          device: "HTP0",
          contextSize: isCertified ? (TESTED_CONTEXT_WINDOWS[id] ?? 65_536) : 32_768,
          strategy: "Fallback: ispezione non riuscita, parametri conservativi",
        };
      }
    } else {
      config = {
        device: "HTP0",
        contextSize: isCertified ? (TESTED_CONTEXT_WINDOWS[id] ?? 65_536) : 32_768,
        strategy: "Discovery veloce (ispezione saltata)",
      };
    }

    models.push({
      id,
      fileName,
      filePath,
      sizeGb: meta ? meta.size_gb : 0,
      status: isCertified ? "certified" : "untested",
      device: config.device,
      tensorSplit: config.tensorSplit,
      contextWindow: isCertified ? (TESTED_CONTEXT_WINDOWS[id] ?? config.contextSize) : config.contextSize,
      strategy: config.strategy,
      metadata: meta,
      mmprojPath,
    });
  }

  return models;
}

export interface SyncModelsDeps {
  listDir: ListDirFn;
  exists: ExistsFn;
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  exec: ExecFn;
}

export interface SyncModelsOptions {
  modelsDir: string;
  iniPath: string;
  workspaceDir?: string;
  deps: SyncModelsDeps;
  inspectScript?: string;
  skipInspection?: boolean;
}

export interface SyncModelsResult {
  addedModels: string[];
  totalModels: number;
  iniUpdated: boolean;
}

/**
 * Sincronizza i modelli scoperti sul disco (.cache/geniex/models) con il file INI
 * e la configurazione Kilo (kilo.json/kilo.jsonc) calcolando l'allocazione hardware euristica
 * ottimale senza avviare benchmark pesanti.
 */
export async function syncDiscoveredModelsToIni(
  options: SyncModelsOptions,
): Promise<SyncModelsResult> {
  const { modelsDir, iniPath, deps } = options;
  if (!(await deps.exists(modelsDir))) {
    return { addedModels: [], totalModels: 0, iniUpdated: false };
  }

  const discovered = await scanModels({
    modelsDir,
    deps: {
      listDir: deps.listDir,
      exists: deps.exists,
      exec: deps.exec,
    },
    inspectScript: options.inspectScript,
    skipInspection: options.skipInspection,
  });

  let iniText = "";
  if (await deps.exists(iniPath)) {
    iniText = await deps.readFile(iniPath).catch(() => "");
  }

  const parsed = parseModelsIni(iniText);
  const existingKeys = new Set(Object.keys(parsed.models));
  const existingFiles = new Set(
    Object.values(parsed.models).map((m) => basename(m.model).toLowerCase()),
  );

  const missing = discovered.filter(
    (m) => !existingKeys.has(m.id) && !existingFiles.has(m.fileName.toLowerCase()),
  );

  if (missing.length === 0) {
    return {
      addedModels: [],
      totalModels: existingKeys.size,
      iniUpdated: false,
    };
  }

  let baseContent = iniText.trimEnd();
  if (!baseContent) {
    baseContent = [
      "version = 1",
      "",
      "# ============================================",
      "# Configurazione automatica modelli Hexagon",
      "# ============================================",
      "",
      "[*]",
      "flash-attn = on",
      "n-gpu-layers = 999",
      "parallel = 1",
      "load-mode = mlock",
      "fit = off",
      "threads = 12",
      "threads-batch = 12",
      "batch-size = 4096",
      "ubatch-size = 512",
      "context-shift = true",
    ].join("\n");
  }

  const newSections: string[] = [];
  const added: string[] = [];

  for (const m of missing) {
    added.push(m.id);
    const arch = m.metadata?.architecture ?? "gguf";
    const quant = m.metadata?.quant_name ?? "Q4";
    newSections.push(
      `# --- ${m.id} (${m.sizeGb.toFixed(2)} GB, ${arch}, ${quant}) ---`,
      `# Strategia: ${m.strategy}`,
      `[${m.id}]`,
      `model = ${m.filePath}`,
      `device = ${m.device}`,
      ...(m.tensorSplit ? [`tensor-split = ${m.tensorSplit}`] : []),
      `ctx-size = ${m.contextWindow}`,
      "",
    );
  }

  const updatedIniText = baseContent + "\n\n" + newSections.join("\n");
  await deps.writeFile(iniPath, updatedIniText);

  // Sincronizza anche %LOCALAPPDATA%/Hexagon/hexagon-models.ini se disponibile
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const userIni = join(localAppData, "Hexagon", "hexagon-models.ini");
    if (userIni.toLowerCase() !== iniPath.toLowerCase()) {
      await deps.writeFile(userIni, updatedIniText).catch(() => {});
    }
  }

  // Sincronizza il workspace se presente un INI locale differente
  if (options.workspaceDir) {
    const wsIni = join(options.workspaceDir, "hexagon-models.ini");
    if (wsIni.toLowerCase() !== iniPath.toLowerCase() && (await deps.exists(wsIni))) {
      await deps.writeFile(wsIni, updatedIniText).catch(() => {});
    }
  }

  // Aggiorna configurazione Kilo provider
  try {
    await installProviderConfig({
      workspaceDir: options.workspaceDir,
      iniPath,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
    });
  } catch {
    /* fallback se la directory .config/kilo non e' accessibile */
  }

  return {
    addedModels: added,
    totalModels: existingKeys.size + added.length,
    iniUpdated: true,
  };
}
