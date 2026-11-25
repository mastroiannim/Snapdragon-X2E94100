/**
 * telemetry.ts — Parser condiviso dei log di llama-server e llama-bench.
 *
 * Estrae:
 * - Offload reale per backend (layer assegnati, layer offloaded/totali, buffer modello/KV/compute in MiB)
 * - Architettura HTP / DMA64 e rilevamento fallback CPU
 * - Tempi di warm-up HTP / caricamento separati dal throughput (prefill/decode tok/s)
 */

export interface RealOffloadTelemetry {
  layersOffloaded?: number;
  layersTotal?: number;
  offloadPercent?: number;
  layersByDevice: Record<string, number>;
  modelBuffersMiB: Record<string, number>;
  kvBuffersMiB: Record<string, number>;
  computeBuffersMiB: Record<string, number>;
  acceleratorPercent?: number;
  cpuFallback?: boolean;
  htpArch?: string;
  dma64?: boolean;
  source?: string;
  modelId?: string;
}

export interface WarmUpTelemetry {
  htpWarmUpMs: number | null;
  loadTimeMs: number | null;
  source?: string;
  attempts?: number;
}

export interface ThroughputTelemetry {
  promptEvalTokPerSec: number | null;
  evalTokPerSec: number | null;
}

export interface ParsedLlamaLogs {
  offload?: RealOffloadTelemetry;
  warmUp: WarmUpTelemetry;
  throughput: ThroughputTelemetry;
  perModel: Record<string, {
    offload: RealOffloadTelemetry;
    warmUp: WarmUpTelemetry;
    throughput: ThroughputTelemetry;
  }>;
}

function normalizeBackendName(raw: string): string {
  const clean = raw.trim();
  const upper = clean.toUpperCase();
  if (upper.startsWith("HTP")) return upper;
  if (upper === "OPENCL" || upper === "GPUOPENCL") return "GPUOpenCL";
  if (upper.startsWith("CPU")) return "CPU";
  return clean;
}

function addFloat(map: Record<string, number>, key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const rounded = Math.round(((map[key] ?? 0) + value) * 100) / 100;
  map[key] = rounded;
}

function setMaxFloat(map: Record<string, number>, key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const rounded = Math.round(value * 100) / 100;
  if (map[key] === undefined || rounded > map[key]) {
    map[key] = rounded;
  }
}

interface LogBlockAccumulator {
  modelId?: string;
  layersByDevice: Record<string, number>;
  seenLayerIndices: Set<number>;
  layersOffloaded?: number;
  layersTotal?: number;
  modelBuffersMiB: Record<string, number>;
  kvBuffersMiB: Record<string, number>;
  computeBuffersMiB: Record<string, number>;
  htpArch?: string;
  dma64?: boolean;
  loadTimeMs: number | null;
  warmUpWallMs: number | null;
  promptEvalTokPerSec: number | null;
  evalTokPerSec: number | null;
}

function createAccumulator(modelId?: string): LogBlockAccumulator {
  return {
    modelId,
    layersByDevice: {},
    seenLayerIndices: new Set<number>(),
    modelBuffersMiB: {},
    kvBuffersMiB: {},
    computeBuffersMiB: {},
    loadTimeMs: null,
    warmUpWallMs: null,
    promptEvalTokPerSec: null,
    evalTokPerSec: null,
  };
}

function hasAnyData(acc: LogBlockAccumulator): boolean {
  return (
    Object.keys(acc.layersByDevice).length > 0 ||
    Object.keys(acc.modelBuffersMiB).length > 0 ||
    Object.keys(acc.kvBuffersMiB).length > 0 ||
    Object.keys(acc.computeBuffersMiB).length > 0 ||
    acc.layersOffloaded !== undefined ||
    acc.loadTimeMs !== null ||
    acc.warmUpWallMs !== null ||
    acc.promptEvalTokPerSec !== null ||
    acc.evalTokPerSec !== null
  );
}

function finalizeBlock(
  acc: LogBlockAccumulator,
  source?: string,
): {
  offload?: RealOffloadTelemetry;
  warmUp: WarmUpTelemetry;
  throughput: ThroughputTelemetry;
} {
  const totalModelMiB = Object.values(acc.modelBuffersMiB).reduce((sum, v) => sum + v, 0);
  const cpuModelMiB = acc.modelBuffersMiB["CPU"] ?? 0;
  const accelModelMiB = Math.max(0, totalModelMiB - cpuModelMiB);

  const acceleratorPercent =
    totalModelMiB > 0 ? Math.round((accelModelMiB / totalModelMiB) * 1000) / 10 : undefined;

  const assignedTotal = Object.values(acc.layersByDevice).reduce((sum, v) => sum + v, 0);
  const assignedCpu = acc.layersByDevice["CPU"] ?? 0;
  const layersTotal = acc.layersTotal ?? (assignedTotal > 0 ? assignedTotal : undefined);
  const layersOffloaded =
    acc.layersOffloaded ??
    (assignedTotal > 0 ? assignedTotal - assignedCpu : undefined);
  const offloadPercent =
    layersOffloaded !== undefined && layersTotal !== undefined && layersTotal > 0
      ? Math.round((layersOffloaded / layersTotal) * 1000) / 10
      : undefined;

  const cpuFallback =
    assignedCpu > 0 ||
    (layersOffloaded !== undefined &&
      layersTotal !== undefined &&
      layersTotal > 0 &&
      layersOffloaded < layersTotal) ||
    (totalModelMiB > 0 && cpuModelMiB > 0 && accelModelMiB === 0) ||
    (acc.computeBuffersMiB["CPU"] !== undefined &&
      Object.keys(acc.computeBuffersMiB).length === 1);

  const hasOffloadData =
    Object.keys(acc.layersByDevice).length > 0 ||
    Object.keys(acc.modelBuffersMiB).length > 0 ||
    Object.keys(acc.kvBuffersMiB).length > 0 ||
    Object.keys(acc.computeBuffersMiB).length > 0 ||
    layersOffloaded !== undefined;

  const offload: RealOffloadTelemetry | undefined = hasOffloadData
    ? {
        ...(layersOffloaded !== undefined ? { layersOffloaded } : {}),
        ...(layersTotal !== undefined ? { layersTotal } : {}),
        ...(offloadPercent !== undefined ? { offloadPercent } : {}),
        layersByDevice: acc.layersByDevice,
        modelBuffersMiB: acc.modelBuffersMiB,
        kvBuffersMiB: acc.kvBuffersMiB,
        computeBuffersMiB: acc.computeBuffersMiB,
        ...(acceleratorPercent !== undefined ? { acceleratorPercent } : {}),
        ...(hasOffloadData ? { cpuFallback } : {}),
        ...(acc.htpArch ? { htpArch: acc.htpArch } : {}),
        ...(acc.dma64 !== undefined ? { dma64: acc.dma64 } : {}),
        ...(source ? { source } : {}),
        ...(acc.modelId ? { modelId: acc.modelId } : {}),
      }
    : undefined;

  const htpWarmUpMs = acc.warmUpWallMs ?? acc.loadTimeMs;

  return {
    ...(offload ? { offload } : {}),
    warmUp: {
      htpWarmUpMs,
      loadTimeMs: acc.loadTimeMs,
      ...(source ? { source } : {}),
    },
    throughput: {
      promptEvalTokPerSec: acc.promptEvalTokPerSec,
      evalTokPerSec: acc.evalTokPerSec,
    },
  };
}

function modelIdFromPathOrAlias(raw: string): string {
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "");
  const parts = cleaned.split(/[\\/]/);
  const file = parts[parts.length - 1] ?? cleaned;
  return file.replace(/\.gguf$/i, "");
}

/**
 * Analizza l'output testuale dei log di llama-server / llama-bench (-lv 3 / -v)
 * estraendo offload reale per-layer e per-buffer, info HTP/DMA64,
 * tempi di warm-up HTP (load time) e throughput di prefill/decode separati.
 */
export function parseLlamaLogs(logText: string, source?: string): ParsedLlamaLogs {
  if (!logText || typeof logText !== "string") {
    return {
      warmUp: { htpWarmUpMs: null, loadTimeMs: null, ...(source ? { source } : {}) },
      throughput: { promptEvalTokPerSec: null, evalTokPerSec: null },
      perModel: {},
    };
  }

  let globalHtpArch: string | undefined;
  let globalDma64: boolean | undefined;

  const blocks: LogBlockAccumulator[] = [];
  let current = createAccumulator();

  const ensureModelBlock = (newModelId: string) => {
    if (current.modelId && current.modelId !== newModelId && hasAnyData(current)) {
      blocks.push(current);
      current = createAccumulator(newModelId);
    } else if (!current.modelId) {
      current.modelId = newModelId;
    }
    if (globalHtpArch && !current.htpArch) current.htpArch = globalHtpArch;
    if (globalDma64 !== undefined && current.dma64 === undefined) current.dma64 = globalDma64;
  };

  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 1. Hardware HTP backend lines (process-level)
    const archMatch = /ggml-hex:\s+Hexagon Arch version\s+(v\d+)(?:,\s*DMA64\s+(enabled|disabled))?/i.exec(trimmed);
    if (archMatch) {
      globalHtpArch = archMatch[1];
      if (archMatch[2]) globalDma64 = archMatch[2].toLowerCase() === "enabled";
      current.htpArch = globalHtpArch;
      if (globalDma64 !== undefined) current.dma64 = globalDma64;
      continue;
    }

    // 2. Model context boundary markers (router or direct load)
    const routerLoadMatch =
      /(?:srv\s+.*?(?:loading model|model\s+name\s*[=:])|load_model:\s+loading model)\s+(?:'([^']+)'|"([^"]+)"|([^\s'"]+))/i.exec(
        trimmed,
      );
    const routerModelRaw = routerLoadMatch?.[1] ?? routerLoadMatch?.[2] ?? routerLoadMatch?.[3];
    if (routerModelRaw) {
      ensureModelBlock(modelIdFromPathOrAlias(routerModelRaw));
      continue;
    }
    const loaderPathMatch = /llama_model_loader:\s+loaded meta data.*?from\s+(.+\.gguf)/i.exec(trimmed);
    if (loaderPathMatch) {
      ensureModelBlock(modelIdFromPathOrAlias(loaderPathMatch[1]));
      continue;
    }

    // 3. Per-layer device assignment
    const layerMatch = /load_tensors:\s+layer\s+(\d+)\s+assigned to device\s+([^,\s]+)/i.exec(trimmed);
    if (layerMatch) {
      const idx = Number.parseInt(layerMatch[1], 10);
      const dev = normalizeBackendName(layerMatch[2]);
      if (!current.seenLayerIndices.has(idx)) {
        current.seenLayerIndices.add(idx);
        current.layersByDevice[dev] = (current.layersByDevice[dev] ?? 0) + 1;
      }
      continue;
    }

    // 4. Summary layer offload
    const offloadedMatch = /load_tensors:\s+offloaded\s+(\d+)\/(\d+)\s+layers/i.exec(trimmed);
    if (offloadedMatch) {
      current.layersOffloaded = Number.parseInt(offloadedMatch[1], 10);
      current.layersTotal = Number.parseInt(offloadedMatch[2], 10);
      continue;
    }

    // 5. Buffer sizes (model, KV, compute)
    const modelBufMatch = /load_tensors:\s+([A-Za-z0-9_-]+)\s+model buffer size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*MiB/i.exec(trimmed);
    if (modelBufMatch) {
      const dev = normalizeBackendName(modelBufMatch[1]);
      const mib = Number.parseFloat(modelBufMatch[2]);
      addFloat(current.modelBuffersMiB, dev, mib);
      continue;
    }
    const kvBufMatch = /llama_kv_cache:\s+([A-Za-z0-9_-]+)\s+KV buffer size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*MiB/i.exec(trimmed);
    if (kvBufMatch) {
      const dev = normalizeBackendName(kvBufMatch[1]);
      const mib = Number.parseFloat(kvBufMatch[2]);
      setMaxFloat(current.kvBuffersMiB, dev, mib);
      continue;
    }
    const computeBufMatch = /sched_reserve:\s+([A-Za-z0-9_-]+)\s+compute buffer size\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*MiB/i.exec(trimmed);
    if (computeBufMatch) {
      const dev = normalizeBackendName(computeBufMatch[1]);
      const mib = Number.parseFloat(computeBufMatch[2]);
      setMaxFloat(current.computeBuffersMiB, dev, mib);
      continue;
    }

    // 6. Warm-up / Load time separated from throughput
    const loadTimeMatch = /load time\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i.exec(trimmed);
    if (loadTimeMatch) {
      const ms = Number.parseFloat(loadTimeMatch[1]);
      if (Number.isFinite(ms)) {
        current.loadTimeMs = Math.round(ms * 100) / 100;
      }
      continue;
    }

    // 7. Prefill & Decode throughput
    const ppMatch = /prompt eval time\s*=\s*[0-9.]+\s*ms\s*\/\s*\d+\s*tokens\s*\([^,]+,\s*([0-9]+(?:\.[0-9]+)?|inf)\s*tokens per second\)/i.exec(trimmed);
    if (ppMatch && ppMatch[1].toLowerCase() !== "inf") {
      const tps = Number.parseFloat(ppMatch[1]);
      if (Number.isFinite(tps) && tps > 0) {
        current.promptEvalTokPerSec = Math.round(tps * 100) / 100;
      }
      continue;
    }
    const tgMatch = /(?:^|\s)eval time\s*=\s*[0-9.]+\s*ms\s*\/\s*\d+\s*(?:runs|tokens)\s*\([^,]+,\s*([0-9]+(?:\.[0-9]+)?|inf)\s*tokens per second\)/i.exec(trimmed);
    if (tgMatch && tgMatch[1].toLowerCase() !== "inf") {
      const tps = Number.parseFloat(tgMatch[1]);
      if (Number.isFinite(tps) && tps > 0) {
        current.evalTokPerSec = Math.round(tps * 100) / 100;
      }
    }
  }

  if (hasAnyData(current)) {
    blocks.push(current);
  }

  const perModel: ParsedLlamaLogs["perModel"] = {};
  let latestFinalized: ReturnType<typeof finalizeBlock> | undefined;

  for (const blk of blocks) {
    const fin = finalizeBlock(blk, source);
    latestFinalized = fin;
    if (blk.modelId && fin.offload) {
      perModel[blk.modelId] = {
        offload: fin.offload,
        warmUp: fin.warmUp,
        throughput: fin.throughput,
      };
    }
  }

  return {
    ...(latestFinalized?.offload ? { offload: latestFinalized.offload } : {}),
    warmUp: latestFinalized?.warmUp ?? {
      htpWarmUpMs: null,
      loadTimeMs: null,
      ...(source ? { source } : {}),
    },
    throughput: latestFinalized?.throughput ?? {
      promptEvalTokPerSec: null,
      evalTokPerSec: null,
    },
    perModel,
  };
}
