/**
 * discovery.ts — Scansione, ispezione e classificazione euristica dei modelli GGUF locali.
 *
 * Distingue modelli CERTIFIED (profilati) da UNTESTED (sperimentali), filtra gli mmproj
 * multimodali e calcola l'allocazione hardware ottimale (HTP0/GPUOpenCL) per lo Snapdragon X2 Elite.
 */
import { basename, dirname, join } from "node:path";
import { installProviderConfig } from "./config.js";
import { TESTED_CONTEXT_WINDOWS } from "./models.js";
import { nodeIsDirectory, nodeListDir } from "./os.js";
import { BUNDLED_INSPECT_SCRIPT, parseModelsIni } from "./process.js";
import {
  defaultRegistryPath,
  loadRegistry,
  type BenchmarkMetrics,
  type ModelsRegistry,
} from "./qualify.js";
import type {
  ExecFn,
  ExistsFn,
  IsDirFn,
  ListDirFn,
  MkdirFn,
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
  contextReason: string;
  strategy: string;
  isMoE: boolean;
  activeParamsEst: string;
  sizeGb: number;
  threads: number;
  threadsBatch: number;
  batchSize: number;
  ubatchSize: number;
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
  metrics?: BenchmarkMetrics;
  error?: string;
}

export interface ScanDeps {
  listDir: ListDirFn;
  exists: ExistsFn;
  exec: ExecFn;
  isDirectory?: IsDirFn;
  readFile?: ReadFileFn;
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
 * Verifica se l'architettura GGUF e' un modello autonomo caricabile.
 * Non filtra a priori architetture LLM: se il runtime corrente non la supporta,
 * sara' llama-server / Kilo a sollevare l'errore in fase di caricamento.
 */
export function isArchitectureSupported(architecture?: string): boolean {
  if (!architecture) return true;
  const lower = architecture.toLowerCase().trim();
  return lower !== "clip";
}

/**
 * Calcola l'allocazione hardware ottimale basata sui metadati GGUF
 * e sui vincoli hardware dello Snapdragon X2 Elite (allineato 1:1 a Get-HexagonOptimalConfig).
 */
export function calculateOptimalConfig(meta: GgufMetadata): OptimalConfig {
  if (!meta || typeof meta.architecture !== "string") {
    return {
      device: "HTP0",
      contextSize: 65_536,
      contextReason: "Fallback: metadati non validi o mancanti",
      strategy: "Fallback: metadati non validi o mancanti",
      isMoE: false,
      activeParamsEst: "100% dense",
      sizeGb: 0,
      threads: 12,
      threadsBatch: 12,
      batchSize: 4096,
      ubatchSize: 512,
    };
  }
  const sizeGb =
    typeof meta.size_gb === "number" && Number.isFinite(meta.size_gb)
      ? meta.size_gb
      : Math.round(((meta.file_size_bytes || 0) / 1_073_741_824) * 100) / 100;
  const expertCount = typeof meta.expert_count === "number" ? meta.expert_count : 0;
  const expertUsed = typeof meta.expert_used_count === "number" ? meta.expert_used_count : 0;
  const isMoE = expertCount > 0 && expertUsed > 0;
  const slidingWindow = typeof meta.sliding_window === "number" ? meta.sliding_window : 0;
  const hasSwa = slidingWindow > 0;
  const quantName = (meta.quant_name ?? "").trim();
  const fileType = typeof meta.file_type === "number" ? meta.file_type : 0;
  const blockCount = typeof meta.block_count === "number" ? meta.block_count : 0;
  const isKQuant = quantName === "K-Quants";
  const isIQ4NL = fileType === 23 || /IQ4_NL/i.test(quantName);
  const isIQQuant =
    quantName === "IQ-Quants" ||
    /^IQ\d/i.test(quantName) ||
    (fileType >= 19 && fileType <= 31 && fileType !== 21);
  const isMXFP4 = fileType === 38 || /MXFP4/i.test(quantName);
  const isType36PlusOther =
    !isMXFP4 &&
    (fileType >= 36 || /^(?:TQ[12]_0|Type_(?:3[6-9]|[4-9]\d|\d{3,}))$/i.test(quantName));
  const isSubByteCompact = isIQQuant || isMXFP4 || isType36PlusOther;
  const archLower = meta.architecture.toLowerCase();
  const metaCtxLen =
    typeof meta.context_length === "number" &&
    Number.isFinite(meta.context_length) &&
    meta.context_length > 0
      ? meta.context_length
      : 0;

  let device = "HTP0";
  let tensorSplit: string | undefined;
  let strategy = "";
  let contextSize = 65_536;
  let contextReason = "";

  // Regola 1: Selezione Dispositivo e Split Vettoriale
  if (isIQQuant && !isIQ4NL) {
    // ggml-opencl.dll implementa kernel nativi IQ1..IQ4; libggml-htp-v81.so supporta solo IQ4_NL
    device = "GPUOpenCL";
    strategy =
      `IQ-Quants (${quantName || `ftype ${fileType}`}): 100% GPUOpenCL — kernel IQ nativi su Adreno senza fallback CPU HTP0`;
  } else if (isMoE) {
    if (sizeGb <= 13.5) {
      if (archLower === "lfm2moe") {
        // L'ibrido HTP0+GPUOpenCL va in access violation (0xC0000005) su lfm2moe
        device = "HTP0";
        strategy =
          "MoE Leggero lfm2moe (LFM2.5): 100% HTP0; l'ibrido GPU va in crash (0xC0000005) su questa architettura";
      } else if (isMXFP4) {
        device = "HTP0,GPUOpenCL";
        tensorSplit = "80,20";
        strategy =
          `MoE Leggero ${quantName || "MXFP4"}: Ibrido HTP0 (80%) + GPU (20%) con kernel MXFP4 nativi su NPU e Adreno`;
      } else {
        device = "HTP0,GPUOpenCL";
        tensorSplit = "80,20";
        strategy =
          "MoE Leggero (LFM/A2B): Ibrido HTP0 (80%) + GPU (20%) per doppio canale di banda RAM (~46 t/s)";
      }
    } else if (isKQuant || isType36PlusOther) {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "85,15";
      strategy = isType36PlusOther
        ? `MoE Gigante ${quantName || `Type_${fileType}`}: Ibrido HTP0 (85%) + GPU (15%) per preservare SIMD NPU e limitare fallback OpenCL`
        : "MoE Gigante K-Quants (Flint): Ibrido HTP0 (85%) + GPU (15%) per preservare SIMD NPU";
    } else {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "50,50";
      strategy = isMXFP4 || isIQ4NL
        ? `MoE Gigante ${quantName || (isMXFP4 ? "MXFP4" : "IQ4_NL")}: Ibrido 50/50 con kernel nativi su NPU HTP0 e GPUOpenCL`
        : "MoE Gigante Q4_0: Ibrido 50/50 per azzerare il fallback CPU e quintuplicare il prefill (152 t/s)";
    }
  } else {
    // Modelli Densi (Full Self-Attention)
    if (sizeGb <= 6.0) {
      device = "HTP0";
      strategy = isSubByteCompact
        ? `Dense Compatto ${quantName || `Type_${fileType}`} (<=6GB): 100% NPU HTP0`
        : "Dense Compatto (<=6GB): 100% NPU HTP0 (prefill 750-3800 t/s, consumo 14-18W)";
    } else if (sizeGb <= 13.5) {
      if (isType36PlusOther) {
        device = "HTP0,GPUOpenCL";
        tensorSplit = "85,15";
        strategy =
          `Dense Medio ${quantName || `Type_${fileType}`}: Ibrido HTP0 (85%) + GPU (15%) per bilanciare buffer sub-byte`;
      } else {
        device = "HTP0,GPUOpenCL";
        tensorSplit = "75,25";
        strategy = isMXFP4 || isIQ4NL
          ? `Dense Medio ${quantName || (isMXFP4 ? "MXFP4" : "IQ4_NL")}: Ibrido HTP0 (75%) + GPU (25%) con kernel nativi`
          : "Dense Medio (Qwen 14B): Ibrido HTP0 (75%) + GPU (25%) per sbloccare la saturazione DMA a contesti lunghi";
      }
    } else if (isKQuant || isType36PlusOther) {
      // K-Quants e Type_36+ non-MXFP4 mantengono output.weight in BF16/FP16 (>2 GiB OpenCL buffer limit)
      device = "HTP0";
      strategy = isType36PlusOther
        ? `Dense Enorme ${quantName || `Type_${fileType}`} (>13.5GB): 100% NPU HTP0 (evita overflow buffer OpenCL 2GB)`
        : "Dense Enorme K-Quants (>15GB): 100% NPU HTP0 (evita overflow buffer OpenCL 2GB per output.weight BF16)";
    } else {
      device = "HTP0,GPUOpenCL";
      tensorSplit = "50,50";
      strategy = isMXFP4 || isIQ4NL
        ? `Dense Enorme ${quantName || (isMXFP4 ? "MXFP4" : "IQ4_NL")}: Ibrido 50/50 per prevenire overflow FastRPC`
        : "Dense Enorme (>15GB): Ibrido 50/50 per prevenire overflow FastRPC e throttling termico";
    }
  }

  // Regola 2: Limite Buffer FastRPC (1 GiB), OpenCL (2 GiB) e Dimensione Contesto (-c)
  if (hasSwa) {
    if (isType36PlusOther) {
      contextSize = metaCtxLen > 0 ? Math.min(65_536, metaCtxLen) : 65_536;
      contextReason = `Sliding Window (${slidingWindow}) su ${quantName || `Type_${fileType}`}: 64k conservativo`;
    } else {
      contextSize = metaCtxLen > 0 ? Math.min(131_072, metaCtxLen) : 131_072;
      contextReason = `Sliding Window attivo (window: ${slidingWindow}): 131k token sicuro e leggerissimo in RAM`;
    }
  } else if (isMoE) {
    if (isType36PlusOther && sizeGb > 13.5) {
      contextSize = 32_768;
      contextReason = `MoE >13.5GB ${quantName || `Type_${fileType}`}: limitato a 32k per pressione buffer/repack`;
    } else {
      contextSize = 65_536;
      contextReason = "MoE: 64k token ottimale (KV Cache nativa f16 senza collo di bottiglia)";
    }
  } else if (isSubByteCompact && sizeGb > 13.5) {
    contextSize = 32_768;
    contextReason =
      `Dense >13.5GB ${quantName || `Type_${fileType}`}: limitato a 32k per buffer KV/output sotto 1-2 GiB`;
  } else if (isType36PlusOther && sizeGb >= 4.5) {
    contextSize = 32_768;
    contextReason =
      `Dense >=4.5GB ${quantName || `Type_${fileType}`}: limitato a 32k per alta densita' layer/FastRPC`;
  } else if (isSubByteCompact && (sizeGb >= 4.5 || blockCount >= 40)) {
    contextSize = 65_536;
    contextReason =
      `Dense sub-byte >=4.5GB (${quantName || `Type_${fileType}`}): limitato a 64k per KV cache/FastRPC`;
  } else if (sizeGb >= 7.0) {
    contextSize = 65_536;
    contextReason =
      "Dense >=7GB: limitato a 64k per rispettare il limite FastRPC NPU < 1 GiB (Error 0x200)";
  } else {
    contextSize = metaCtxLen > 0 ? Math.min(65_536, metaCtxLen) : 65_536;
    contextReason = "Contesto standard per coding agent (64k)";
  }

  // Non superare mai il context_length dichiarato nel GGUF (anche con MoE o dense >= 7GB).
  if (metaCtxLen > 0) {
    contextSize = Math.min(contextSize, metaCtxLen);
  }

  return {
    device,
    tensorSplit,
    contextSize,
    contextReason,
    strategy,
    isMoE,
    activeParamsEst: isMoE ? `${expertUsed} / ${expertCount} exp` : "100% dense",
    sizeGb,
    threads: 12,
    threadsBatch: 12,
    batchSize: 4096,
    ubatchSize: 512,
  };
}

/** Esegue inspect-gguf.ps1 ed estrae i metadati strutturati. */
export async function inspectGguf(
  filePath: string,
  options: InspectOptions,
): Promise<GgufMetadata> {
  const script = options.scriptPath ?? BUNDLED_INSPECT_SCRIPT;
  const result = await options.exec(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", filePath, "-Json"],
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
  incompatibleIds?: Set<string>;
  registry?: ModelsRegistry;
  registryPath?: string;
  inspectScript?: string;
  skipInspection?: boolean;
}

interface CollectedGguf {
  fileName: string;
  filePath: string;
  dirPath: string;
}

async function collectGgufFiles(modelsDir: string, deps: ScanDeps): Promise<CollectedGguf[]> {
  const isDir = deps.isDirectory ?? (deps.listDir === nodeListDir ? nodeIsDirectory : undefined);
  const collected: CollectedGguf[] = [];
  const queue: string[] = [modelsDir];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    let entries: string[];
    if (currentDir === modelsDir) {
      entries = await deps.listDir(currentDir);
    } else {
      try {
        entries = await deps.listDir(currentDir);
      } catch {
        continue;
      }
    }
    const sorted = [...entries].sort((a, b) => a.localeCompare(b));
    const subdirs: string[] = [];

    for (const entry of sorted) {
      if (entry.toLowerCase().endsWith(".gguf")) {
        collected.push({
          fileName: entry,
          filePath: join(currentDir, entry),
          dirPath: currentDir,
        });
      } else if (isDir && !entry.startsWith(".")) {
        const subPath = join(currentDir, entry);
        if (await isDir(subPath)) {
          subdirs.push(subPath);
        }
      }
    }
    queue.push(...subdirs);
  }

  return collected;
}

function findMmprojForModel(
  id: string,
  dirPaths: string[],
  modelsDir: string,
  mmprojByName: Map<string, string>,
  mmprojByDir: Map<string, string[]>,
): string | undefined {
  const idLower = id.toLowerCase();
  const baseName = idLower.replace(/[-_]?(?:q\d[a-z0-9_]*|f16|bf16|f32)$/i, "");
  const strippedQuant = idLower.replace(
    /[-_](?:ud[-_])?(?:iq\d+[a-z0-9_]*|q\d+[a-z0-9_]*|bf16|f16|f32)(?=[-_]|$)/gi,
    "",
  );

  const stems = strippedQuant && strippedQuant !== baseName ? [baseName, strippedQuant] : [baseName];
  const candidates = [
    `mmproj-${idLower}-f16.gguf`,
    `mmproj-${idLower}-bf16.gguf`,
    `mmproj-${idLower}.gguf`,
    `${idLower}-mmproj.gguf`,
    ...stems.flatMap((stem) => [
      `mmproj-${stem}-f16.gguf`,
      `mmproj-${stem}-bf16.gguf`,
      `mmproj-${stem}.gguf`,
      `${stem}-mmproj.gguf`,
    ]),
  ];
  for (const cand of candidates) {
    const match = mmprojByName.get(cand);
    if (match) return match;
  }

  for (const stem of stems) {
    if (!stem) continue;
    for (const [mmKey, mmVal] of mmprojByName.entries()) {
      if (mmKey.startsWith(`mmproj-${stem}`) || mmKey.includes(stem)) {
        return mmVal;
      }
    }
  }

  for (const dirPath of dirPaths) {
    if (dirPath === modelsDir) continue;
    const inDir = mmprojByDir.get(dirPath);
    if (inDir && inDir.length > 0) {
      return inDir[0];
    }
  }
  return undefined;
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

  const ggufEntries = await collectGgufFiles(modelsDir, deps);

  // Separa proiettori multimodali dai modelli LLM, deduplicando per ID (root prioritario).
  const mmprojByName = new Map<string, string>();
  const mmprojByDir = new Map<string, string[]>();
  const modelMap = new Map<string, { fileName: string; filePath: string; dirPaths: string[] }>();

  for (const entry of ggufEntries) {
    if (isMmprojFile(entry.fileName)) {
      const lower = entry.fileName.toLowerCase();
      if (!mmprojByName.has(lower)) {
        mmprojByName.set(lower, entry.filePath);
      }
      const list = mmprojByDir.get(entry.dirPath) ?? [];
      list.push(entry.filePath);
      mmprojByDir.set(entry.dirPath, list);
    } else {
      const id = entry.fileName.replace(/\.gguf$/i, "");
      const existing = modelMap.get(id);
      if (existing) {
        existing.dirPaths.push(entry.dirPath);
      } else {
        modelMap.set(id, {
          fileName: entry.fileName,
          filePath: entry.filePath,
          dirPaths: [entry.dirPath],
        });
      }
    }
  }

  let registry: ModelsRegistry = options.registry ?? {};
  if (!options.registry && (options.registryPath || deps.readFile)) {
    registry = await loadRegistry(options.registryPath ?? defaultRegistryPath(), {
      readFile: deps.readFile,
    });
  }

  const incompatibleSet = options.incompatibleIds ?? new Set<string>();
  const registryCertifiedIds = Object.entries(registry)
    .filter(([, prof]) => prof?.status === "certified")
    .map(([id]) => id);
  const certifiedSet =
    options.certifiedIds ??
    new Set([...Object.keys(TESTED_CONTEXT_WINDOWS), ...registryCertifiedIds]);
  const entries = [...modelMap.entries()];
  const models: DiscoveredModel[] = new Array(entries.length);

  const inspectOne = async ([id, info]: [
    string,
    { fileName: string; filePath: string; dirPaths: string[] },
  ]): Promise<DiscoveredModel> => {
    const registryEntry = registry[id];
    const isRegistryIncompatible =
      registryEntry?.status === "incompatible" || incompatibleSet.has(id);
    const isRegistryCertified =
      !isRegistryIncompatible && registryEntry?.status === "certified";
    const isCertified =
      !isRegistryIncompatible && (isRegistryCertified || certifiedSet.has(id));
    const mmprojPath = findMmprojForModel(id, info.dirPaths, modelsDir, mmprojByName, mmprojByDir);

    let meta: GgufMetadata | undefined;
    let config: OptimalConfig;

    if (!options.skipInspection) {
      try {
        meta = await inspectGguf(info.filePath, {
          exec: deps.exec,
          scriptPath: options.inspectScript,
        });
        config = calculateOptimalConfig(meta);
      } catch {
        config = {
          device: "HTP0",
          contextSize: isCertified ? (TESTED_CONTEXT_WINDOWS[id] ?? 65_536) : 32_768,
          contextReason: "Fallback: ispezione non riuscita",
          strategy: "Fallback: ispezione non riuscita, parametri conservativi",
          isMoE: false,
          activeParamsEst: "100% dense",
          sizeGb: 0,
          threads: 12,
          threadsBatch: 12,
          batchSize: 4096,
          ubatchSize: 512,
        };
      }
    } else {
      config = {
        device: "HTP0",
        contextSize: isCertified ? (TESTED_CONTEXT_WINDOWS[id] ?? 65_536) : 32_768,
        contextReason: "Discovery veloce (ispezione saltata)",
        strategy: "Discovery veloce (ispezione saltata)",
        isMoE: false,
        activeParamsEst: "100% dense",
        sizeGb: 0,
        threads: 12,
        threadsBatch: 12,
        batchSize: 4096,
        ubatchSize: 512,
      };
    }

    const isSupported = isArchitectureSupported(meta?.architecture);
    const status: ModelStatus =
      !isSupported || isRegistryIncompatible
        ? "incompatible"
        : isCertified
          ? "certified"
          : "untested";
    const strategy = !isSupported
      ? `Incompatibile: architettura '${meta?.architecture ?? "sconosciuta"}' non supportata dal runtime llama.cpp installato`
      : isRegistryIncompatible
        ? `Incompatibile: ${registryEntry?.error ?? "marcato INCOMPATIBLE in models-registry.json"}`
        : config.strategy;

    const device = isRegistryCertified && registryEntry.device ? registryEntry.device : config.device;
    const tensorSplit =
      isRegistryCertified && registryEntry.device
        ? registryEntry.tensorSplit
        : config.tensorSplit;

    const rawCtx = isRegistryCertified && registryEntry.contextWindow > 0
      ? registryEntry.contextWindow
      : isCertified
        ? (TESTED_CONTEXT_WINDOWS[id] ?? config.contextSize)
        : config.contextSize;
    const contextWindow =
      meta && meta.context_length > 0 ? Math.min(rawCtx, meta.context_length) : rawCtx;

    return {
      id,
      fileName: info.fileName,
      filePath: info.filePath,
      sizeGb: meta ? meta.size_gb : 0,
      status,
      device,
      tensorSplit,
      contextWindow,
      strategy,
      metadata: meta,
      mmprojPath,
      ...(isRegistryCertified && registryEntry.metrics ? { metrics: registryEntry.metrics } : {}),
      ...(isRegistryIncompatible && registryEntry?.error ? { error: registryEntry.error } : {}),
    };
  };

  // Concorrenza limitata per velocizzare l'ispezione multi-modello preservando l'ordine
  const concurrency = 4;
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (nextIdx < entries.length) {
      const idx = nextIdx++;
      models[idx] = await inspectOne(entries[idx]);
    }
  });
  await Promise.all(workers);

  return models;
}

export function formatIniHeader(timestamp = new Date().toISOString()): string {
  return [
    "version = 1",
    "",
    "# ============================================",
    "# Generato automaticamente da @hexagon/kilo-plugin (TypeScript)",
    `# Data: ${timestamp}`,
    "# Piattaforma: Snapdragon X2 Elite Extreme",
    "# ============================================",
    "",
    "# Default globali applicati a tutti i modelli",
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

export function formatModelIniSection(model: DiscoveredModel): string[] {
  const displayName = model.metadata?.model_name || model.id;
  const arch = model.metadata?.architecture ?? "gguf";
  const quant = model.metadata?.quant_name ?? "Q4";
  return [
    `# --- ${displayName} (${model.sizeGb.toFixed(2)} GB, ${arch}, ${quant}) ---`,
    `# Strategia: ${model.strategy}`,
    `[${model.id}]`,
    `model = ${model.filePath}`,
    `device = ${model.device}`,
    ...(model.tensorSplit ? [`tensor-split = ${model.tensorSplit}`] : []),
    `ctx-size = ${model.contextWindow}`,
    ...(model.mmprojPath ? [`mmproj = ${model.mmprojPath}`] : []),
    "",
  ];
}

export function renderModelsIni(models: DiscoveredModel[], timestamp?: string): string {
  const sections = models.flatMap((model) => formatModelIniSection(model));
  return `${formatIniHeader(timestamp)}\n\n${sections.join("\n")}`;
}

export interface GenerateIniOptions {
  modelsDir: string;
  deps: ScanDeps;
  inspectScript?: string;
  skipInspection?: boolean;
  timestamp?: string;
  registryPath?: string;
  registry?: ModelsRegistry;
}

export interface GenerateIniResult {
  iniContent: string;
  models: DiscoveredModel[];
  modelCount: number;
}

/**
 * Genera l'intero contenuto di hexagon-models.ini in TypeScript puro,
 * applicando le euristiche hardware 1:1 (device, split, clamp contesto, mmproj).
 */
export async function generateModelsIni(
  options: GenerateIniOptions,
): Promise<GenerateIniResult> {
  const discovered = await scanModels({
    modelsDir: options.modelsDir,
    deps: options.deps,
    inspectScript: options.inspectScript,
    skipInspection: options.skipInspection,
    registryPath: options.registryPath,
    registry: options.registry,
  });
  const validModels = discovered.filter((m) => m.status !== "incompatible");
  if (validModels.length === 0) {
    throw new Error(
      `Nessun modello GGUF valido trovato in ${options.modelsDir}: ` +
        "scaricare un modello con GenieX (geniex pull) prima di generare hexagon-models.ini.",
    );
  }
  return {
    iniContent: renderModelsIni(validModels, options.timestamp),
    models: validModels,
    modelCount: validModels.length,
  };
}

export interface SyncModelsDeps {
  listDir: ListDirFn;
  exists: ExistsFn;
  readFile: ReadFileFn;
  writeFile: WriteFileFn;
  exec: ExecFn;
  mkdir?: MkdirFn;
  isDirectory?: IsDirFn;
}

export interface SyncModelsOptions {
  modelsDir: string;
  iniPath: string;
  workspaceDir?: string;
  localAppData?: string;
  configDir?: string;
  registryPath?: string;
  registry?: ModelsRegistry;
  deps: SyncModelsDeps;
  inspectScript?: string;
  skipInspection?: boolean;
}

export interface SyncModelsResult {
  addedModels: string[];
  removedModels: string[];
  totalModels: number;
  iniUpdated: boolean;
}

/**
 * Sincronizza i modelli scoperti sul disco (.cache/geniex/models) con il file INI
 * e la configurazione Kilo (kilo.json/kilo.jsonc) calcolando l'allocazione hardware euristica
 * ottimale senza avviare benchmark pesanti. Aggiunge nuovi modelli e rimuove voci i cui file
 * non esistono piu' su disco o marcate INCOMPATIBLE in models-registry.json.
 */
export async function syncDiscoveredModelsToIni(
  options: SyncModelsOptions,
): Promise<SyncModelsResult> {
  const { modelsDir, iniPath, deps } = options;
  if (!(await deps.exists(modelsDir))) {
    return { addedModels: [], removedModels: [], totalModels: 0, iniUpdated: false };
  }

  const registry: ModelsRegistry =
    options.registry ??
    (await loadRegistry(options.registryPath ?? defaultRegistryPath(), {
      readFile: deps.readFile,
    }));

  const discovered = await scanModels({
    modelsDir,
    deps: {
      listDir: deps.listDir,
      exists: deps.exists,
      exec: deps.exec,
      isDirectory: deps.isDirectory,
      readFile: deps.readFile,
    },
    registry,
    inspectScript: options.inspectScript,
    skipInspection: options.skipInspection,
  });
  const discoveredById = new Map(discovered.map((m) => [m.id, m]));

  let iniText = "";
  if (await deps.exists(iniPath)) {
    iniText = await deps.readFile(iniPath).catch(() => "");
  }

  const parsed = parseModelsIni(iniText);
  const removedModels: string[] = [];
  let baseContent = iniText;

  for (const [id, cfg] of Object.entries(parsed.models)) {
    const isIncompatible =
      discoveredById.get(id)?.status === "incompatible" ||
      registry[id]?.status === "incompatible";
    if (!cfg.model || !(await deps.exists(cfg.model)) || isIncompatible) {
      removedModels.push(id);
      const escaped = id.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
      const sectionPattern = new RegExp(
        `(?:^|\\r?\\n)(?:#[^\\r\\n]*\\r?\\n)*\\[${escaped}\\][\\s\\S]*?(?=(?:\\r?\\n#[^\\r\\n]*\\r?\\n)*\\r?\\n\\[|\\r?\\n\\[|$)`,
        "g",
      );
      baseContent = baseContent.replace(sectionPattern, "");
    }
  }

  const remainingParsed = removedModels.length > 0 ? parseModelsIni(baseContent) : parsed;
  const existingKeys = new Set(Object.keys(remainingParsed.models));
  const existingFiles = new Set(
    Object.values(remainingParsed.models).map((m) => basename(m.model).toLowerCase()),
  );

  const missing = discovered.filter(
    (m) =>
      m.status !== "incompatible" &&
      !existingKeys.has(m.id) &&
      !existingFiles.has(m.fileName.toLowerCase()),
  );

  if (missing.length === 0 && removedModels.length === 0) {
    return {
      addedModels: [],
      removedModels: [],
      totalModels: existingKeys.size,
      iniUpdated: false,
    };
  }

  baseContent = baseContent.trimEnd();
  if (!baseContent) {
    baseContent = formatIniHeader();
  }

  const newSections: string[] = [];
  const added: string[] = [];

  for (const m of missing) {
    added.push(m.id);
    newSections.push(...formatModelIniSection(m));
  }

  const updatedIniText =
    newSections.length > 0
      ? baseContent + "\n\n" + newSections.join("\n")
      : baseContent + "\n";
  await deps.writeFile(iniPath, updatedIniText);

  // Sincronizza anche %LOCALAPPDATA%/Hexagon/hexagon-models.ini se disponibile
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
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
      configDir: options.configDir,
      iniPath,
      registryPath: options.registryPath,
      registry,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      exists: deps.exists,
      mkdir: deps.mkdir,
    });
  } catch {
    /* fallback se la directory .config/kilo non e' accessibile */
  }

  return {
    addedModels: added,
    removedModels,
    totalModels: existingKeys.size + added.length,
    iniUpdated: true,
  };
}
