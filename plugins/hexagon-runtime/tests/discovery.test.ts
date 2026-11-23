import { describe, expect, it, vi } from "vitest";
import {
  calculateOptimalConfig,
  inspectGguf,
  isMmprojFile,
  scanModels,
  type GgufMetadata,
} from "../src/discovery.js";
import { okExec, recordingExec } from "./helpers.js";

describe("discovery.ts — isMmprojFile", () => {
  it("riconosce file di proiezione multimodale", () => {
    expect(isMmprojFile("mmproj-Ornith-1.5-9B-f16.gguf")).toBe(true);
    expect(isMmprojFile("gemma-4-E2B-it-mmproj.gguf")).toBe(true);
    expect(isMmprojFile("MMPROJ-F32.gguf")).toBe(true);
    expect(isMmprojFile("Ornith-1.5-9B-Q4_0.gguf")).toBe(false);
    expect(isMmprojFile("flint-UD-Q4_K_XL.gguf")).toBe(false);
  });
});

describe("calculateOptimalConfig — Euristiche hardware", () => {
  it("Dense <= 6GB: 100% NPU HTP0", () => {
    const meta: GgufMetadata = {
      architecture: "qwen2",
      model_name: "Qwen 7B",
      context_length: 32768,
      embedding_length: 4096,
      block_count: 28,
      head_count: 28,
      head_count_kv: 4,
      expert_count: 0,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 4_500_000_000,
      size_gb: 4.19,
      quant_name: "Q4_0",
      is_moe: false,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0");
    expect(cfg.tensorSplit).toBeUndefined();
    expect(cfg.contextSize).toBe(32768);
  });

  it("Dense Medio (6-13.5GB): Ibrido 75/25 per sollievo DMA", () => {
    const meta: GgufMetadata = {
      architecture: "qwen2",
      model_name: "Qwen 14B",
      context_length: 131072,
      embedding_length: 5120,
      block_count: 48,
      head_count: 40,
      head_count_kv: 8,
      expert_count: 0,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 8_500_000_000,
      size_gb: 7.92,
      quant_name: "Q4_0",
      is_moe: false,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0,GPUOpenCL");
    expect(cfg.tensorSplit).toBe("75,25");
    expect(cfg.contextSize).toBe(65536); // limitato per DMA FastRPC < 1GB
  });

  it("Dense Enorme (>13.5GB): 100% GPU Adreno", () => {
    const meta: GgufMetadata = {
      architecture: "qwen2",
      model_name: "Qwen 27B",
      context_length: 65536,
      embedding_length: 5120,
      block_count: 64,
      head_count: 40,
      head_count_kv: 8,
      expert_count: 0,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 16_000_000_000,
      size_gb: 15.2,
      quant_name: "Q4_0",
      is_moe: false,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("GPUOpenCL");
  });

  it("LFM2.5 MoE: forzato 100% HTP0 per evitare crash GPU", () => {
    const meta: GgufMetadata = {
      architecture: "lfm2moe",
      model_name: "LFM2.5 24B",
      context_length: 65536,
      embedding_length: 2048,
      block_count: 32,
      head_count: 32,
      head_count_kv: 4,
      expert_count: 16,
      expert_used_count: 2,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 13_000_000_000,
      size_gb: 12.1,
      quant_name: "Q4_0",
      is_moe: true,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0");
    expect(cfg.strategy).toContain("0xC0000005");
  });

  it("MoE Leggero (<=13.5GB): split 80/20", () => {
    const meta: GgufMetadata = {
      architecture: "qwen2moe",
      model_name: "Qwen MoE 14B",
      context_length: 32768,
      embedding_length: 2048,
      block_count: 28,
      head_count: 16,
      head_count_kv: 4,
      expert_count: 8,
      expert_used_count: 2,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 9_000_000_000,
      size_gb: 8.5,
      quant_name: "Q4_0",
      is_moe: true,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0,GPUOpenCL");
    expect(cfg.tensorSplit).toBe("80,20");
  });

  it("MoE Gigante non-KQuant (>13.5GB): split 50/50", () => {
    const meta: GgufMetadata = {
      architecture: "deepseek",
      model_name: "DeepSeek MoE",
      context_length: 32768,
      embedding_length: 4096,
      block_count: 60,
      head_count: 32,
      head_count_kv: 8,
      expert_count: 64,
      expert_used_count: 6,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 20_000_000_000,
      size_gb: 19.0,
      quant_name: "Q4_0",
      is_moe: true,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0,GPUOpenCL");
    expect(cfg.tensorSplit).toBe("50,50");
  });

  it("MoE con Sliding Window (Flint): contesto esteso 131k", () => {
    const meta: GgufMetadata = {
      architecture: "flint",
      model_name: "Flint Preview",
      context_length: 262144,
      embedding_length: 2048,
      block_count: 49,
      head_count: 32,
      head_count_kv: 4,
      expert_count: 256,
      expert_used_count: 6,
      sliding_window: 513,
      file_type: 15,
      file_size_bytes: 25_000_000_000,
      size_gb: 23.3,
      quant_name: "K-Quants",
      is_moe: true,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0,GPUOpenCL");
    expect(cfg.tensorSplit).toBe("85,15");
    expect(cfg.contextSize).toBe(131072);
  });
});

describe("inspectGguf", () => {
  it("esegue inspect-gguf.ps1 ed estrae i metadati", async () => {
    const payload: GgufMetadata = {
      architecture: "qwen35",
      model_name: "Ornith",
      context_length: 262144,
      embedding_length: 4096,
      block_count: 32,
      head_count: 16,
      head_count_kv: 4,
      expert_count: 0,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 5482832768,
      size_gb: 5.11,
      quant_name: "Q4_0",
      is_moe: false,
    };
    const { fn: exec, calls } = recordingExec(() => okExec(JSON.stringify(payload)));
    const meta = await inspectGguf("C:/models/Ornith.gguf", { exec });
    expect(meta.architecture).toBe("qwen35");
    expect(calls[0].command).toBe("powershell");
    expect(calls[0].args).toContain("-Json");
  });

  it("errore di esecuzione propagato con messaggio descrittivo", async () => {
    const { fn: exec } = recordingExec(() => ({
      code: 1,
      stdout: "",
      stderr: "File illeggibile",
    }));
    await expect(inspectGguf("C:/models/corrupt.gguf", { exec })).rejects.toThrow(
      /Ispezione GGUF fallita/,
    );
  });
});

describe("scanModels", () => {
  it("separa mmproj, associa al modello madre e classifica certified vs untested", async () => {
    const files = [
      "Ornith-1.5-9B-Q4_0.gguf",
      "mmproj-Ornith-1.5-9B-f16.gguf",
      "nuovo-modello-Q4_0.gguf",
      "readme.txt",
    ];

    const listDir = vi.fn(async () => files);
    const exists = vi.fn(async () => true);
    const exec = vi.fn(async () =>
      okExec(
        JSON.stringify({
          architecture: "llama",
          model_name: "Test Model",
          context_length: 32768,
          embedding_length: 4096,
          block_count: 32,
          head_count: 32,
          head_count_kv: 8,
          expert_count: 0,
          expert_used_count: 0,
          sliding_window: 0,
          file_type: 2,
          file_size_bytes: 4_000_000_000,
          size_gb: 3.72,
          quant_name: "Q4_0",
          is_moe: false,
        }),
      ),
    );

    const models = await scanModels({
      modelsDir: "C:/models",
      deps: { listDir, exists, exec },
      certifiedIds: new Set(["Ornith-1.5-9B-Q4_0"]),
    });

    expect(models).toHaveLength(2); // mmproj e readme esclusi dai modelli
    const ornith = models.find((m) => m.id === "Ornith-1.5-9B-Q4_0")!;
    expect(ornith.status).toBe("certified");
    expect(ornith.mmprojPath).toContain("mmproj-Ornith-1.5-9B-f16.gguf");

    const nuovo = models.find((m) => m.id === "nuovo-modello-Q4_0")!;
    expect(nuovo.status).toBe("untested");
    expect(nuovo.device).toBe("HTP0");
  });

  it("supporta skipInspection: true", async () => {
    const files = ["modello1.gguf"];
    const listDir = vi.fn(async () => files);
    const exists = vi.fn(async () => true);
    const exec = vi.fn(async () => okExec("{}"));

    const models = await scanModels({
      modelsDir: "C:/models",
      deps: { listDir, exists, exec },
      skipInspection: true,
    });

    expect(models).toHaveLength(1);
    expect(models[0].strategy).toContain("ispezione saltata");
    expect(exec).not.toHaveBeenCalled();
  });

  it("gestisce fallback conservativo se inspectGguf fallisce o torna errore", async () => {
    const files = ["rotto.gguf"];
    const listDir = vi.fn(async () => files);
    const exists = vi.fn(async () => true);
    const exec = vi.fn(async () => okExec(JSON.stringify({ Error: "Intestazione invalida" })));

    const models = await scanModels({
      modelsDir: "C:/models",
      deps: { listDir, exists, exec },
    });

    expect(models).toHaveLength(1);
    expect(models[0].strategy).toContain("Fallback: ispezione non riuscita");
  });

  it("directory inesistente ritorna array vuoto", async () => {
    const listDir = vi.fn(async () => []);
    const exists = vi.fn(async () => false);
    const exec = vi.fn(async () => okExec(""));
    const models = await scanModels({
      modelsDir: "C:/nonexistent",
      deps: { listDir, exists, exec },
    });
    expect(models).toEqual([]);
  });

  it("associa mmproj tramite matching su prefisso/baseName", async () => {
    const files = [
      "CustomVision-7B-Q4_K_M.gguf",
      "mmproj-customvision-7b-vision-encoder.gguf",
    ];
    const listDir = vi.fn(async () => files);
    const exists = vi.fn(async () => true);
    const exec = vi.fn(async () => okExec("{}"));

    const models = await scanModels({
      modelsDir: "C:/models",
      deps: { listDir, exists, exec },
      skipInspection: true,
    });

    expect(models).toHaveLength(1);
    expect(models[0].mmprojPath).toContain("mmproj-customvision-7b-vision-encoder.gguf");
  });
});
