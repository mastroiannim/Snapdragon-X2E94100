import { describe, expect, it, vi } from "vitest";
import {
  buildHexagonProvider,
  calculateOutputLimit,
  installProviderConfig,
  RECOMMENDED_MAIN_MODEL,
  RECOMMENDED_SMALL_MODEL,
  resolveGlobalConfigPath,
  RESOLVED_PLUGIN_DIR,
  stripJsonComments,
} from "../src/config.js";

describe("config.ts — Calcolo limiti e parsing", () => {
  it("calculateOutputLimit: formula per contesti lunghi e corti", () => {
    expect(calculateOutputLimit(65_536)).toBe(16_384);
    expect(calculateOutputLimit(131_072)).toBe(16_384);
    expect(calculateOutputLimit(16_384)).toBe(4_096);
    expect(calculateOutputLimit(4_096)).toBe(2_048);
    expect(calculateOutputLimit(1_024)).toBe(1_024);
  });

  it("stripJsonComments: rimuove commenti a riga singola e multiriga", () => {
    const raw = `{\n  // commento riga\n  "key": "val" /* commento inline */\n}`;
    const cleaned = stripJsonComments(raw);
    expect(cleaned).not.toContain("// commento riga");
    expect(cleaned).not.toContain("/* commento inline */");
    expect(JSON.parse(cleaned)).toEqual({ key: "val" });
  });

  it("resolveGlobalConfigPath: default sotto .config/kilo", () => {
    const custom = resolveGlobalConfigPath("C:/custom/kilo");
    expect(custom).toContain("C:\\custom\\kilo");
  });
});

describe("buildHexagonProvider", () => {
  it("costruisce la configurazione provider con host e porta personalizzati", () => {
    const provider = buildHexagonProvider(undefined, { host: "127.0.0.2", port: 19999 });
    expect(provider.name).toBe("Hexagon Local Runtime");
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe("http://127.0.0.2:19999/v1");
    expect(provider.models[RECOMMENDED_MAIN_MODEL]).toBeDefined();
    expect(provider.models[RECOMMENDED_MAIN_MODEL].limit.context).toBe(65_536);
  });
});

describe("installProviderConfig", () => {
  it("scrive nuova configurazione globale se il file non esiste", async () => {
    const writtenFiles = new Map<string, string>();
    const readFile = vi.fn(async (path: string) => {
      const content = writtenFiles.get(path);
      if (content !== undefined) return content;
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      configDir: "C:/test-config/kilo",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    expect(res.modelCount).toBeGreaterThan(0);
    const written = writtenFiles.get(res.targetPath);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.provider.hexagon).toBeDefined();
    expect(parsed.model).toBe(`hexagon/${RECOMMENDED_MAIN_MODEL}`);
    expect(parsed.small_model).toBe(`hexagon/${RECOMMENDED_SMALL_MODEL}`);
  });

  it("fa il merge conservando provider esistenti", async () => {
    const writtenFiles = new Map<string, string>();
    const target = "C:\\test-config\\kilo\\kilo.jsonc";
    writtenFiles.set(
      target,
      JSON.stringify({
        provider: {
          anthropic: { name: "Anthropic", npm: "@ai-sdk/anthropic" },
        },
        model: "anthropic/claude-3-opus",
      }),
    );

    const readFile = vi.fn(async (path: string) => {
      const content = writtenFiles.get(path);
      if (content !== undefined) return content;
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      configDir: "C:/test-config/kilo",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const written = writtenFiles.get(res.targetPath);
    const parsed = JSON.parse(written!);
    expect(parsed.provider.anthropic).toBeDefined();
    expect(parsed.provider.hexagon).toBeDefined();
    // Preserva il modello preferito preesistente
    expect(parsed.model).toBe("anthropic/claude-3-opus");
  });

  it("non duplica il plugin se già presente", async () => {
    const writtenFiles = new Map<string, string>();
    const target = "C:\\test-config\\kilo\\kilo.json";
    writtenFiles.set(
      target,
      JSON.stringify({
        plugin: [RESOLVED_PLUGIN_DIR],
      }),
    );

    const readFile = vi.fn(async (path: string) => writtenFiles.get(path)!);
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      configDir: "C:/test-config/kilo",
      mainModel: "solo-modello",
      smallModel: "solo-modello",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(writtenFiles.get(res.targetPath)!);
    expect(parsed.plugin).toEqual([RESOLVED_PLUGIN_DIR]);
    expect(parsed.model).toBe("hexagon/solo-modello");
    expect(parsed.small_model).toBe("hexagon/solo-modello");
  });

  it("migra @hexagon/kilo-plugin non risolvibile al percorso effettivo", async () => {
    const writtenFiles = new Map<string, string>();
    const target = "C:\\test-config\\kilo\\kilo.json";
    writtenFiles.set(
      target,
      JSON.stringify({
        plugin: ["@hexagon/kilo-plugin"],
      }),
    );

    const readFile = vi.fn(async (path: string) => writtenFiles.get(path)!);
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      configDir: "C:/test-config/kilo",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(writtenFiles.get(res.targetPath)!);
    expect(parsed.plugin).toEqual([RESOLVED_PLUGIN_DIR]);
  });

  it("usa percorso relativo se il plugin esiste nel workspace", async () => {
    const writtenFiles = new Map<string, string>();
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    // In questo repo, plugins/hexagon-runtime esiste nella root
    const rootDir = process.cwd().replace(/\\plugins\\hexagon-runtime$/, "").replace(/\/plugins\/hexagon-runtime$/, "");
    const res = await installProviderConfig({
      workspaceDir: rootDir,
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(writtenFiles.get(res.targetPath)!);
    expect(parsed.plugin).toContain("./plugins/hexagon-runtime");
  });

  it("scrive kilo.json locale se workspaceDir e' specificato", async () => {
    const writtenFiles = new Map<string, string>();
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      workspaceDir: "C:/my-project",
      readFile,
      writeFile,
    });

    expect(res.targetPath).toBe("C:\\my-project\\kilo.json");
    expect(res.updated).toBe(true);
  });

  it("supporta host e porta personalizzati, e modelli custom", async () => {
    const writtenFiles = new Map<string, string>();
    const readFile = vi.fn(async () => {
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      workspaceDir: "C:/custom-proj",
      host: "192.168.1.50",
      port: 18888,
      mainModel: "flint-UD-Q4_K_XL",
      smallModel: "MiniCPM5-2B-Q4_K_M",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(writtenFiles.get(res.targetPath)!);
    expect(parsed.provider.hexagon.options.baseURL).toBe("http://192.168.1.50:18888/v1");
    expect(parsed.model).toBe("hexagon/flint-UD-Q4_K_XL");
    expect(parsed.small_model).toBe("hexagon/MiniCPM5-2B-Q4_K_M");
  });

  it("recupera da JSON corrotto nel target", async () => {
    const writtenFiles = new Map<string, string>();
    const target = "C:\\test-corrupt\\kilo\\kilo.jsonc";
    writtenFiles.set(target, "{ json corrotto non parsabile");

    const readFile = vi.fn(async (path: string) => {
      const content = writtenFiles.get(path);
      if (content !== undefined) return content;
      throw new Error("File not found");
    });
    const writeFile = vi.fn(async (path: string, content: string) => {
      writtenFiles.set(path, content);
    });

    const res = await installProviderConfig({
      configDir: "C:/test-corrupt/kilo",
      readFile,
      writeFile,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(writtenFiles.get(res.targetPath)!);
    expect(parsed.provider.hexagon).toBeDefined();
  });
});
