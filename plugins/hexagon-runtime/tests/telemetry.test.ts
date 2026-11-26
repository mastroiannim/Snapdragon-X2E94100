import { describe, expect, it } from "vitest";
import { parseLlamaLogs } from "../src/telemetry.js";

describe("telemetry.ts — parseLlamaLogs", () => {
  it("gestisce testo vuoto o non valido senza crash", () => {
    expect(parseLlamaLogs("", "empty.log")).toEqual({
      warmUp: { htpWarmUpMs: null, loadTimeMs: null, source: "empty.log" },
      throughput: { promptEvalTokPerSec: null, evalTokPerSec: null },
      perModel: {},
    });
    expect(parseLlamaLogs(undefined as unknown as string)).toEqual({
      warmUp: { htpWarmUpMs: null, loadTimeMs: null },
      throughput: { promptEvalTokPerSec: null, evalTokPerSec: null },
      perModel: {},
    });
  });

  it("estrae offload reale, architettura HTP/DMA64, warm-up separato e throughput da log llama-bench", () => {
    const sample = [
      "ggml-hex: Hexagon Arch version v81, DMA64 enabled",
      "llama_model_loader: loaded meta data with 40 key-value pairs from C:\\models\\Qwen3.5-0.8B-WSP-Q4_0.gguf",
      "load_tensors: layer   0 assigned to device HTP0, is_swa = 0",
      "load_tensors: layer   0 assigned to device HTP0, is_swa = 0",
      "load_tensors: layer   1 assigned to device HTP0, is_swa = 0",
      "load_tensors: layer   2 assigned to device OpenCL, is_swa = 0",
      "load_tensors: layer   3 assigned to device Vulkan0, is_swa = 0",
      "load_tensors: offloaded 26/26 layers to GPU",
      "load_tensors:       HTP0 model buffer size =   412.50 MiB",
      "load_tensors:     OpenCL model buffer size =    88.25 MiB",
      "llama_kv_cache:     HTP0 KV buffer size =    96.00 MiB",
      "llama_kv_cache:     HTP0 KV buffer size =   128.50 MiB",
      "sched_reserve:      HTP0 compute buffer size =    44.00 MiB",
      "sched_reserve:    GPUOpenCL compute buffer size =    18.25 MiB",
      "llama_perf_context_print:        load time =  1425.75 ms",
      "llama_perf_context_print: prompt eval time =   400.00 ms /   512 tokens (    0.78 ms per token,  1280.40 tokens per second)",
      "llama_perf_context_print:        eval time =  2560.00 ms /   128 runs   (   20.00 ms per token,    50.00 tokens per second)",
    ].join("\n");

    const parsed = parseLlamaLogs(sample, "bench_stderr.txt");
    expect(parsed.offload).toEqual({
      layersOffloaded: 26,
      layersTotal: 26,
      offloadPercent: 100,
      layersByDevice: { HTP0: 2, GPUOpenCL: 1, Vulkan0: 1 },
      modelBuffersMiB: { HTP0: 412.5, GPUOpenCL: 88.25 },
      kvBuffersMiB: { HTP0: 128.5 },
      computeBuffersMiB: { HTP0: 44, GPUOpenCL: 18.25 },
      acceleratorPercent: 100,
      cpuFallback: false,
      htpArch: "v81",
      dma64: true,
      source: "bench_stderr.txt",
      modelId: "Qwen3.5-0.8B-WSP-Q4_0",
    });
    expect(parsed.warmUp).toEqual({
      htpWarmUpMs: 1425.75,
      loadTimeMs: 1425.75,
      source: "bench_stderr.txt",
    });
    expect(parsed.throughput).toEqual({
      promptEvalTokPerSec: 1280.4,
      evalTokPerSec: 50,
    });
    expect(parsed.perModel["Qwen3.5-0.8B-WSP-Q4_0"]).toBeDefined();
  });

  it("rileva fallback CPU dai layer e buffer CPU anche senza summary offloaded", () => {
    const sample = [
      "ggml-hex: Hexagon Arch version v79, DMA64 disabled",
      "load_tensors: layer 0 assigned to device HTP0",
      "load_tensors: layer 1 assigned to device CPU_REPACK",
      "load_tensors: CPU model buffer size = 1200.00 MiB",
      "sched_reserve: CPU compute buffer size = 256.00 MiB",
      "llama_perf_context_print: prompt eval time = 0.00 ms / 1 tokens ( 0.00 ms per token, inf tokens per second)",
      "llama_perf_context_print: eval time = 0.00 ms / 1 runs ( 0.00 ms per token, inf tokens per second)",
    ].join("\n");

    const parsed = parseLlamaLogs(sample);
    expect(parsed.offload?.layersTotal).toBe(2);
    expect(parsed.offload?.layersOffloaded).toBe(1);
    expect(parsed.offload?.offloadPercent).toBe(50);
    expect(parsed.offload?.cpuFallback).toBe(true);
    expect(parsed.offload?.acceleratorPercent).toBe(0);
    expect(parsed.offload?.htpArch).toBe("v79");
    expect(parsed.offload?.dma64).toBe(false);
    expect(parsed.throughput).toEqual({
      promptEvalTokPerSec: null,
      evalTokPerSec: null,
    });
  });

  it("separa più modelli nei log router di llama-server e ignora offload se presenti solo timings", () => {
    const multiLog = [
      "ggml-hex: Hexagon Arch version v81, DMA64 enabled",
      "srv  loading model 'ModelA'",
      "load_tensors: offloaded 32/32 layers to GPU",
      "load_tensors: HTP0 model buffer size = 5000.00 MiB",
      "llama_perf_context_print: load time = 1800.00 ms",
      "srv  loading model 'ModelB'",
      "load_tensors: offloaded 20/24 layers to GPU",
      "load_tensors: HTP0 model buffer size = 1500.00 MiB",
      "load_tensors: CPU model buffer size = 500.00 MiB",
      "llama_perf_context_print: load time = 900.25 ms",
      "llama_perf_context_print: eval time = 1000.00 ms / 40 runs (25.00 ms per token, 40.00 tokens per second)",
    ].join("\n");

    const parsed = parseLlamaLogs(multiLog, "llama-server.log");
    expect(Object.keys(parsed.perModel)).toEqual(["ModelA", "ModelB"]);
    expect(parsed.perModel["ModelA"].offload.offloadPercent).toBe(100);
    expect(parsed.perModel["ModelA"].warmUp.loadTimeMs).toBe(1800);
    expect(parsed.perModel["ModelB"].offload.cpuFallback).toBe(true);
    expect(parsed.perModel["ModelB"].offload.acceleratorPercent).toBe(75);
    expect(parsed.offload?.modelId).toBe("ModelB");
    expect(parsed.warmUp.loadTimeMs).toBe(900.25);

    const timingsOnly = parseLlamaLogs("llama_perf_context_print: load time = 450.00 ms\n");
    expect(timingsOnly.offload).toBeUndefined();
    expect(timingsOnly.warmUp.loadTimeMs).toBe(450);
    expect(timingsOnly.warmUp.htpWarmUpMs).toBe(450);

    const backendFmt = parseLlamaLogs(
      "Hexagon backend: arch=v79 dma64=1\nload_tensors: offloaded 10/10 layers to GPU\n",
      "bench",
    );
    expect(backendFmt.offload?.htpArch).toBe("v79");
    expect(backendFmt.offload?.dma64).toBe(true);
  });
});
