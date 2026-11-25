import { describe, expect, it, vi } from "vitest";
import {
  calculateOptimalConfig,
  generateModelsIni,
  inspectGguf,
  isMmprojFile,
  scanModels,
  syncDiscoveredModelsToIni,
  type GgufMetadata,
} from "../src/discovery.js";
import { okExec, recordingExec, recordingWriteFile } from "./helpers.js";

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
  it("Fallback prudente per metadati non validi o mancanti", () => {
    const cfg = calculateOptimalConfig({} as GgufMetadata);
    expect(cfg.device).toBe("HTP0");
    expect(cfg.contextSize).toBe(65536);
    expect(cfg.strategy).toContain("Fallback");
  });

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

  it("Dense Enorme non-KQuant (>13.5GB): Ibrido 50/50 allineato a Get-HexagonOptimalConfig", () => {
    const meta: GgufMetadata = {
      architecture: "qwen35",
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
      file_size_bytes: 16_350_000_000,
      size_gb: 15.23,
      quant_name: "Q4_0",
      is_moe: false,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0,GPUOpenCL");
    expect(cfg.tensorSplit).toBe("50,50");
    expect(cfg.contextSize).toBe(65536);
  });

  it("Dense Enorme K-Quants (>13.5GB): 100% NPU HTP0 per evitare overflow OpenCL 2GB", () => {
    const meta: GgufMetadata = {
      architecture: "qwen35",
      model_name: "Qwen 27B K-Quant",
      context_length: 65536,
      embedding_length: 5120,
      block_count: 64,
      head_count: 40,
      head_count_kv: 8,
      expert_count: 0,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 15,
      file_size_bytes: 16_500_000_000,
      size_gb: 15.37,
      quant_name: "K-Quants",
      is_moe: false,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.device).toBe("HTP0");
    expect(cfg.tensorSplit).toBeUndefined();
    expect(cfg.contextSize).toBe(65536);
    expect(cfg.strategy).toContain("OpenCL 2GB");
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

  it("MoE Leggero (<=13.5GB): split 80/20 e clamp context_length", () => {
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
    expect(cfg.contextSize).toBe(32768);
  });

  it("MoE Gigante non-KQuant (>13.5GB): split 50/50 e clamp context_length", () => {
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
    expect(cfg.contextSize).toBe(32768);
  });

  it("MoE con Sliding Window (Flint): contesto esteso 131k e clamp se context_length minore", () => {
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

    const clampedSwa = calculateOptimalConfig({ ...meta, context_length: 65536 });
    expect(clampedSwa.contextSize).toBe(65536);

    const zeroCtxSwa = calculateOptimalConfig({ ...meta, context_length: 0 });
    expect(zeroCtxSwa.contextSize).toBe(131072);
  });

  it("expert_count > 0 senza expert_used_count tratta il modello come dense (parita' PS1)", () => {
    const meta: GgufMetadata = {
      architecture: "llama",
      model_name: "Pseudo MoE",
      context_length: 0,
      embedding_length: 4096,
      block_count: 32,
      head_count: 32,
      head_count_kv: 8,
      expert_count: 8,
      expert_used_count: 0,
      sliding_window: 0,
      file_type: 2,
      file_size_bytes: 4_000_000_000,
      size_gb: Number.NaN,
      quant_name: "Q4_0",
      is_moe: true,
    };
    const cfg = calculateOptimalConfig(meta);
    expect(cfg.isMoE).toBe(false);
    expect(cfg.device).toBe("HTP0");
    expect(cfg.contextSize).toBe(65536);
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

    const { fn: execStdout } = recordingExec(() => ({
      code: 2,
      stdout: "stdout err",
      stderr: "",
    }));
    await expect(inspectGguf("C:/models/corrupt.gguf", { exec: execStdout })).rejects.toThrow(
      /stdout err/,
    );

    const { fn: execEmpty } = recordingExec(() => ({
      code: 3,
      stdout: "",
      stderr: "",
    }));
    await expect(inspectGguf("C:/models/corrupt.gguf", { exec: execEmpty })).rejects.toThrow(
      /errore sconosciuto/,
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

  it("marca architettura clip come incompatible", async () => {
    const listDir = vi.fn(async () => ["clip-only.gguf"]);
    const exists = vi.fn(async () => true);
    const exec = vi.fn(async () =>
      okExec(
        JSON.stringify({
          architecture: "clip",
          model_name: "CLIP",
          context_length: 512,
          embedding_length: 768,
          block_count: 12,
          head_count: 12,
          head_count_kv: 12,
          expert_count: 0,
          expert_used_count: 0,
          sliding_window: 0,
          file_type: 1,
          file_size_bytes: 500_000_000,
          size_gb: 0.5,
          quant_name: "F16",
          is_moe: false,
        }),
      ),
    );

    const models = await scanModels({
      modelsDir: "/virtual/models",
      deps: { listDir, exists, exec },
    });

    expect(models).toHaveLength(1);
    expect(models[0].status).toBe("incompatible");
    expect(models[0].strategy).toContain("Incompatibile");
  });

  it("associa mmproj con quant interno (gemma-4-E2B_q4_0-it) e scansiona sottodirectory con deduplica", async () => {
    const tree: Record<string, string[]> = {
      "/models": ["gemma-4-E2B_q4_0-it.gguf", "gemma-4-E2B-it-mmproj.gguf", "unsloth", ".cache"],
      "/models/unsloth": ["Inkling-2-Mini-UD-Q4_K_M.gguf", "mmproj-F16.gguf", "gemma-4-E2B_q4_0-it.gguf"],
    };
    const listDir = vi.fn(async (dir: string) => {
      const key = dir.replace(/\\/g, "/");
      if (!(key in tree)) throw new Error("unreadable");
      return tree[key];
    });
    const isDirectory = vi.fn(async (p: string) => {
      const key = p.replace(/\\/g, "/");
      return key in tree;
    });
    const models = await scanModels({
      modelsDir: "/models",
      deps: {
        listDir,
        exists: async () => true,
        exec: vi.fn(async () => okExec("{}")),
        isDirectory,
      },
      skipInspection: true,
    });
    expect(models).toHaveLength(2);
    const gemma = models.find((m) => m.id === "gemma-4-E2B_q4_0-it")!;
    expect(gemma.filePath.replace(/\\/g, "/")).toBe("/models/gemma-4-E2B_q4_0-it.gguf");
    expect(gemma.mmprojPath?.replace(/\\/g, "/")).toBe("/models/gemma-4-E2B-it-mmproj.gguf");
    const inkling = models.find((m) => m.id === "Inkling-2-Mini-UD-Q4_K_M")!;
    expect(inkling.mmprojPath?.replace(/\\/g, "/")).toBe("/models/unsloth/mmproj-F16.gguf");
  });
});

describe("discovery.ts — syncDiscoveredModelsToIni", () => {
  it("scopre nuovi modelli da geniex pull e li aggiunge all'INI senza benchmark", async () => {
    const listDir = vi.fn(async () => [
      "Ornith-1.5-9B-Q4_0.gguf",
      "Inkling-2-Mini-UD-Q4_K_M.gguf",
    ]);
    const exists = vi.fn(async (p: string) => !p.endsWith("kilo.json"));
    const existingIni = `[*]
flash-attn = on

[Ornith-1.5-9B-Q4_0]
model = /virtual/models/Ornith-1.5-9B-Q4_0.gguf
device = HTP0
ctx-size = 65536
`;
    const storage = new Map<string, string>([["/virtual/models/hexagon-models.ini", existingIni]]);
    const readFile = vi.fn(async (p: string) => storage.get(p) ?? "");
    const { fn: writeFile, calls: writeCalls } = recordingWriteFile();

    const res = await syncDiscoveredModelsToIni({
      modelsDir: "/virtual/models",
      iniPath: "/virtual/models/hexagon-models.ini",
      workspaceDir: "/virtual/workspace",
      localAppData: "",
      configDir: "/virtual/config",
      skipInspection: true,
      deps: {
        listDir,
        exists,
        readFile,
        writeFile,
        exec: vi.fn(),
        mkdir: vi.fn(),
      },
    });

    expect(res.iniUpdated).toBe(true);
    expect(res.addedModels).toEqual(["Inkling-2-Mini-UD-Q4_K_M"]);
    expect(res.totalModels).toBe(2);

    const updatedIni = writeCalls.find((c) => c.path === "/virtual/models/hexagon-models.ini")?.content;
    expect(updatedIni).toBeDefined();
    expect(updatedIni).toContain("[Inkling-2-Mini-UD-Q4_K_M]");
    expect(updatedIni).toContain("Inkling-2-Mini-UD-Q4_K_M.gguf");
    expect(updatedIni).toContain("[Ornith-1.5-9B-Q4_0]");
  });

  it("se tutti i modelli sono già presenti nell'INI, non scrive nulla", async () => {
    const listDir = vi.fn(async () => ["Ornith-1.5-9B-Q4_0.gguf"]);
    const exists = vi.fn(async () => true);
    const existingIni = `[*]
flash-attn = on

[Ornith-1.5-9B-Q4_0]
model = /virtual/models/Ornith-1.5-9B-Q4_0.gguf
device = HTP0
ctx-size = 65536
`;
    const readFile = vi.fn(async () => existingIni);
    const { fn: writeFile, calls: writeCalls } = recordingWriteFile();

    const res = await syncDiscoveredModelsToIni({
      modelsDir: "/virtual/models",
      iniPath: "/virtual/models/hexagon-models.ini",
      skipInspection: true,
      deps: {
        listDir,
        exists,
        readFile,
        writeFile,
        exec: vi.fn(),
        mkdir: vi.fn(),
      },
    });

    expect(res.iniUpdated).toBe(false);
    expect(res.addedModels).toHaveLength(0);
    expect(res.removedModels).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
  });

  it("rimuove dall'INI i modelli eliminati da disco", async () => {
    const listDir = vi.fn(async () => ["Ornith-1.5-9B-Q4_0.gguf"]);
    const exists = vi.fn(async (p: string) => !p.includes("Deleted-Model") && !p.endsWith("kilo.json"));
    const existingIni = `[*]
flash-attn = on

# --- Ornith-1.5-9B-Q4_0 ---
[Ornith-1.5-9B-Q4_0]
model = /virtual/models/Ornith-1.5-9B-Q4_0.gguf
device = HTP0
ctx-size = 65536

# --- Deleted-Model ---
[Deleted-Model]
model = /virtual/models/Deleted-Model.gguf
device = HTP0
ctx-size = 32768
`;
    const readFile = vi.fn(async () => existingIni);
    const { fn: writeFile, calls: writeCalls } = recordingWriteFile();

    const res = await syncDiscoveredModelsToIni({
      modelsDir: "/virtual/models",
      iniPath: "/virtual/models/hexagon-models.ini",
      localAppData: "",
      skipInspection: true,
      deps: { listDir, exists, readFile, writeFile, exec: vi.fn(), mkdir: vi.fn() },
    });

    expect(res.iniUpdated).toBe(true);
    expect(res.removedModels).toEqual(["Deleted-Model"]);
    expect(res.totalModels).toBe(1);
    const updatedIni = writeCalls.find((c) => c.path === "/virtual/models/hexagon-models.ini")?.content;
    expect(updatedIni).toContain("[Ornith-1.5-9B-Q4_0]");
    expect(updatedIni).not.toContain("[Deleted-Model]");
  });

  it("modelsDir inesistente: ritorna zero modifiche", async () => {
    const res = await syncDiscoveredModelsToIni({
      modelsDir: "/virtual/missing",
      iniPath: "/virtual/missing/hexagon-models.ini",
      deps: {
        listDir: vi.fn(async () => []),
        exists: vi.fn(async () => false),
        readFile: vi.fn(async () => ""),
        writeFile: vi.fn(async () => {}),
        exec: vi.fn(),
        mkdir: vi.fn(),
      },
    });
    expect(res).toEqual({ addedModels: [], removedModels: [], totalModels: 0, iniUpdated: false });
  });

  it("crea header INI predefinito, sincronizza localAppData/workspace e gestisce errore installProviderConfig", async () => {
    const listDir = vi.fn(async () => ["hybrid-moe.gguf"]);
    const exists = vi.fn(async (p: string) => {
      const norm = p.replace(/\\/g, "/");
      if (norm.endsWith("/models")) return true;
      if (norm.endsWith("/ws/hexagon-models.ini")) return true;
      if (norm.endsWith("kilo.json")) return true; // fa leggere "{corrotto" a installProviderConfig
      return false;
    });
    const exec = vi.fn(async () =>
      okExec(
        JSON.stringify({
          architecture: "qwen2moe",
          model_name: "Hybrid MoE",
          context_length: 65536,
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
        }),
      ),
    );
    const readFile = vi.fn(async (p: string) => {
      if (p.endsWith("kilo.json")) return "{corrotto";
      return "";
    });
    const { fn: writeFile, calls: writeCalls } = recordingWriteFile();

    const res = await syncDiscoveredModelsToIni({
      modelsDir: "/virtual/models",
      iniPath: "/virtual/ini/hexagon-models.ini",
      workspaceDir: "/virtual/ws",
      localAppData: "/virtual/appdata",
      deps: { listDir, exists, readFile, writeFile, exec, mkdir: vi.fn() },
    });

    expect(res.iniUpdated).toBe(true);
    expect(res.addedModels).toEqual(["hybrid-moe"]);
    const iniWritten = writeCalls.find((c) => c.path === "/virtual/ini/hexagon-models.ini")?.content;
    expect(iniWritten).toContain("version = 1");
    expect(iniWritten).toContain("tensor-split = 80,20");
    expect(writeCalls.some((c) => c.path.includes("appdata") && c.path.endsWith("hexagon-models.ini"))).toBe(true);
    expect(writeCalls.some((c) => c.path.includes("ws") && c.path.endsWith("hexagon-models.ini"))).toBe(true);
  });

  it("generateModelsIni: genera INI completo con mmproj, clamp e filtra clip", async () => {
    const listDir = vi.fn(async () => [
      "Ornith-1.5-9B-Q4_0.gguf",
      "mmproj-Ornith-1.5-9B-f16.gguf",
      "clip-only.gguf",
    ]);
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      const target = args[args.indexOf("-Path") + 1] ?? "";
      if (target.includes("clip-only")) {
        return okExec(
          JSON.stringify({
            architecture: "clip",
            model_name: "CLIP",
            context_length: 512,
            embedding_length: 768,
            block_count: 12,
            head_count: 12,
            head_count_kv: 12,
            expert_count: 0,
            expert_used_count: 0,
            sliding_window: 0,
            file_type: 1,
            file_size_bytes: 500_000_000,
            size_gb: 0.5,
            quant_name: "F16",
            is_moe: false,
          }),
        );
      }
      return okExec(
        JSON.stringify({
          architecture: "qwen35",
          model_name: "Ornith 1.5 9B",
          context_length: 32768,
          embedding_length: 4096,
          block_count: 32,
          head_count: 16,
          head_count_kv: 4,
          expert_count: 0,
          expert_used_count: 0,
          sliding_window: 0,
          file_type: 2,
          file_size_bytes: 5_482_832_768,
          size_gb: 5.11,
          quant_name: "Q4_0",
          is_moe: false,
        }),
      );
    });
    const res = await generateModelsIni({
      modelsDir: "/virtual/models",
      deps: { listDir, exists: async () => true, exec },
      timestamp: "2026-11-25T16:40:00Z",
    });
    expect(res.modelCount).toBe(1);
    expect(res.iniContent).toContain("version = 1");
    expect(res.iniContent).toContain("[Ornith-1.5-9B-Q4_0]");
    expect(res.iniContent).toContain("ctx-size = 32768");
    expect(res.iniContent).toContain("mmproj = ");
    expect(res.iniContent).toContain("mmproj-Ornith-1.5-9B-f16.gguf");
    expect(res.iniContent).not.toContain("[clip-only]");

    await expect(
      generateModelsIni({
        modelsDir: "/virtual/empty",
        deps: { listDir: async () => [], exists: async () => true, exec },
      }),
    ).rejects.toThrow(/Nessun modello GGUF valido/);
  });
});
