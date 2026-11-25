import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHexagonProvider,
  calculateOutputLimit,
  installProviderConfig,
  RECOMMENDED_MAIN_MODEL,
  RECOMMENDED_SMALL_MODEL,
  resolveGlobalConfigPath,
  resolvePluginSpecifier,
  RESOLVED_PLUGIN_DIR,
  stripJsonComments,
} from "../src/config.js";

function createMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const [k, v] of Object.entries(initial)) {
    files.set(k, v);
    dirs.add(dirname(k));
  }
  const mkdirCalls: string[] = [];
  const readFile = vi.fn(async (path: string) => {
    const content = files.get(path);
    if (content !== undefined) return content;
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
  const writeFile = vi.fn(async (path: string, content: string) => {
    files.set(path, content);
    dirs.add(dirname(path));
  });
  const exists = vi.fn(async (path: string) => files.has(path) || dirs.has(path));
  const mkdir = vi.fn(async (path: string) => {
    mkdirCalls.push(path);
    dirs.add(path);
  });
  return { files, dirs, mkdirCalls, readFile, writeFile, exists, mkdir };
}

const tempRoots: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

  it("stripJsonComments: preserva URL con // e /* */ dentro stringhe e gestisce escape", () => {
    const raw = [
      "{",
      '  "$schema": "https://app.kilo.ai/config.json", // schema URL',
      '  "baseURL": "http://127.0.0.1:18803/v1",',
      '  "blockInside": "/* non e un commento */",',
      '  "escapedQuote": "a\\\\\\"//ancora-stringa",',
      '  "escapedBackslash": "fine\\\\" // commento dopo backslash escapato',
      "}",
      "// commento finale senza newline",
    ].join("\r\n");
    const cleaned = stripJsonComments(raw);
    const parsed = JSON.parse(cleaned);
    expect(parsed.$schema).toBe("https://app.kilo.ai/config.json");
    expect(parsed.baseURL).toBe("http://127.0.0.1:18803/v1");
    expect(parsed.blockInside).toBe("/* non e un commento */");
    expect(parsed.escapedQuote).toBe('a\\"//ancora-stringa');
    expect(parsed.escapedBackslash).toBe("fine\\");
    expect(cleaned).toContain("\r\n");
  });

  it("stripJsonComments: gestisce slash isolati e commenti /* non chiusi a EOF", () => {
    expect(stripJsonComments('{"a": 1}/')).toBe('{"a": 1}/');
    expect(stripJsonComments('{"a": 1}/* non chiuso')).toBe('{"a": 1}');
  });

  it("resolveGlobalConfigPath: default sotto .config/kilo e fallback kilo.json", () => {
    const custom = resolveGlobalConfigPath("C:/custom/kilo", () => false);
    expect(custom).toBe(join("C:/custom/kilo", "kilo.jsonc"));

    const existingJson = resolveGlobalConfigPath(
      "C:/custom/kilo",
      (p) => p.endsWith("kilo.json"),
    );
    expect(existingJson).toBe(join("C:/custom/kilo", "kilo.json"));

    const def = resolveGlobalConfigPath(undefined, () => false);
    expect(def).toContain(join(".config", "kilo", "kilo.jsonc"));
  });

  it("resolvePluginSpecifier: supporta override, workspace locale e fallback", () => {
    expect(resolvePluginSpecifier({ pluginSpecifier: "custom-spec" })).toBe("custom-spec");
    expect(
      resolvePluginSpecifier({
        workspaceDir: "/ws",
        exists: (p) => p.endsWith("hexagon-runtime"),
      }),
    ).toBe("./plugins/hexagon-runtime");
    expect(resolvePluginSpecifier({ workspaceDir: "/ws", exists: () => false })).toBe(
      RESOLVED_PLUGIN_DIR,
    );
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

    const hostOnly = buildHexagonProvider(undefined, { host: "127.0.0.3" });
    expect(hostOnly.options.baseURL).toBe("http://127.0.0.3:18803/v1");

    const portOnly = buildHexagonProvider(undefined, { port: 20000 });
    expect(portOnly.options.baseURL).toBe("http://127.0.0.1:20000/v1");
  });
});

describe("installProviderConfig", () => {
  it("scrive nuova configurazione globale se il file non esiste (senza backup)", async () => {
    const fs = createMemoryFs();

    const res = await installProviderConfig({
      configDir: "/virtual-config/kilo",
      iniPath: "/virtual-config/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    expect(res.backupPath).toBeUndefined();
    expect(res.modelCount).toBeGreaterThan(0);
    expect(fs.mkdirCalls).toContain(join("/virtual-config/kilo"));
    const written = fs.files.get(res.targetPath);
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!);
    expect(parsed.provider.hexagon).toBeDefined();
    expect(parsed.model).toBe(`hexagon/${RECOMMENDED_MAIN_MODEL}`);
    expect(parsed.small_model).toBe(`hexagon/${RECOMMENDED_SMALL_MODEL}`);
  });

  it("fa il merge di JSONC con URL e crea backup timestamped preservando il contenuto originale", async () => {
    const target = join("/virtual-config/kilo", "kilo.jsonc");
    const originalRaw = `{
  // configurazione utente con URL
  "$schema": "https://app.kilo.ai/config.json",
  "provider": {
    "anthropic": { "name": "Anthropic", "npm": "@ai-sdk/anthropic" }
  },
  "model": "anthropic/claude-3-opus"
}`;
    const fs = createMemoryFs({ [target]: originalRaw });
    const fixedNow = new Date(2026, 10, 25, 16, 5, 9).getTime();

    const res = await installProviderConfig({
      configDir: "/virtual-config/kilo",
      iniPath: "/virtual-config/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
      now: () => fixedNow,
    });

    expect(res.updated).toBe(true);
    expect(res.backupPath).toBe(`${target}.bak-20261125-160509`);
    expect(fs.files.get(res.backupPath!)).toBe(originalRaw);

    const parsed = JSON.parse(fs.files.get(res.targetPath)!);
    expect(parsed.$schema).toBe("https://app.kilo.ai/config.json");
    expect(parsed.provider.anthropic).toBeDefined();
    expect(parsed.provider.hexagon).toBeDefined();
    expect(parsed.model).toBe("anthropic/claude-3-opus");
  });

  it("disambigua il nome backup in caso di collisione nello stesso secondo", async () => {
    const target = join("/virtual-config/kilo", "kilo.jsonc");
    const fixedNow = new Date(2026, 10, 25, 16, 5, 9).getTime();
    const firstBackup = `${target}.bak-20261125-160509`;
    const fs = createMemoryFs({
      [target]: JSON.stringify({ model: "anthropic/claude" }),
      [firstBackup]: "vecchio-backup",
    });

    const res = await installProviderConfig({
      configDir: "/virtual-config/kilo",
      iniPath: "/virtual-config/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
      now: () => fixedNow,
    });

    expect(res.backupPath).toBe(`${target}.bak-20261125-160509-1`);
    expect(fs.files.get(firstBackup)).toBe("vecchio-backup");
    expect(fs.files.get(res.backupPath!)).toBe(JSON.stringify({ model: "anthropic/claude" }));
  });

  it("non duplica il plugin se già presente in kilo.json", async () => {
    const target = join("/virtual-config/kilo", "kilo.json");
    const fs = createMemoryFs({
      [target]: JSON.stringify({
        plugin: [RESOLVED_PLUGIN_DIR],
      }),
    });

    const res = await installProviderConfig({
      configDir: "/virtual-config/kilo",
      iniPath: "/virtual-config/missing.ini",
      mainModel: "solo-modello",
      smallModel: "solo-modello",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    expect(res.targetPath).toBe(target);
    expect(res.backupPath).toMatch(/kilo\.json\.bak-\d{8}-\d{6}$/);
    const parsed = JSON.parse(fs.files.get(res.targetPath)!);
    expect(parsed.plugin).toEqual([RESOLVED_PLUGIN_DIR]);
    expect(parsed.model).toBe("hexagon/solo-modello");
    expect(parsed.small_model).toBe("hexagon/solo-modello");
  });

  it("migra @hexagon/kilo-plugin non risolvibile al percorso effettivo", async () => {
    const target = join("/virtual-config/kilo", "kilo.json");
    const fs = createMemoryFs({
      [target]: JSON.stringify({
        plugin: ["@hexagon/kilo-plugin", "altro-plugin"],
      }),
    });

    const res = await installProviderConfig({
      configDir: "/virtual-config/kilo",
      iniPath: "/virtual-config/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(fs.files.get(res.targetPath)!);
    expect(parsed.plugin).toEqual([RESOLVED_PLUGIN_DIR, "altro-plugin"]);
  });

  it("usa percorso relativo se plugins/hexagon-runtime esiste nel workspace", async () => {
    const fs = createMemoryFs();
    const ws = "/virtual-ws";
    fs.dirs.add(join(ws, "plugins", "hexagon-runtime"));

    const res = await installProviderConfig({
      workspaceDir: ws,
      iniPath: "/virtual-ws/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(fs.files.get(res.targetPath)!);
    expect(parsed.plugin).toContain("./plugins/hexagon-runtime");
  });

  it("scrive kilo.json locale se workspaceDir e' specificato", async () => {
    const fs = createMemoryFs();

    const res = await installProviderConfig({
      workspaceDir: "/virtual-project",
      iniPath: "/virtual-project/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.targetPath).toBe(join("/virtual-project", "kilo.json"));
    expect(res.updated).toBe(true);
  });

  it("supporta host e porta personalizzati, e modelli custom", async () => {
    const fs = createMemoryFs();

    const res = await installProviderConfig({
      workspaceDir: "/virtual-custom",
      iniPath: "/virtual-custom/missing.ini",
      host: "192.168.1.50",
      port: 18888,
      mainModel: "flint-UD-Q4_K_XL",
      smallModel: "MiniCPM5-2B-Q4_K_M",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    const parsed = JSON.parse(fs.files.get(res.targetPath)!);
    expect(parsed.provider.hexagon.options.baseURL).toBe("http://192.168.1.50:18888/v1");
    expect(parsed.model).toBe("hexagon/flint-UD-Q4_K_XL");
    expect(parsed.small_model).toBe("hexagon/MiniCPM5-2B-Q4_K_M");

    const hostOnly = await installProviderConfig({
      workspaceDir: "/virtual-host-only",
      iniPath: "/virtual-host-only/missing.ini",
      host: "127.0.0.9",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });
    expect(JSON.parse(fs.files.get(hostOnly.targetPath)!).provider.hexagon.options.baseURL).toBe(
      "http://127.0.0.9:18803/v1",
    );

    const portOnly = await installProviderConfig({
      workspaceDir: "/virtual-port-only",
      iniPath: "/virtual-port-only/missing.ini",
      port: 19991,
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });
    expect(JSON.parse(fs.files.get(portOnly.targetPath)!).provider.hexagon.options.baseURL).toBe(
      "http://127.0.0.1:19991/v1",
    );
  });

  it("rifiuta la sovrascrittura su JSON non parsabile lasciando intatto il file", async () => {
    const target = join("/virtual-corrupt/kilo", "kilo.jsonc");
    const corrupt = "{ json corrotto non parsabile";
    const fs = createMemoryFs({ [target]: corrupt });

    await expect(
      installProviderConfig({
        configDir: "/virtual-corrupt/kilo",
        iniPath: "/virtual-corrupt/missing.ini",
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        exists: fs.exists,
        mkdir: fs.mkdir,
      }),
    ).rejects.toThrow(/non parsabile.*file lasciato intatto/);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.files.get(target)).toBe(corrupt);
    expect(fs.files.size).toBe(1);
  });

  it("rifiuta JSON valido ma non oggetto (array/primitivo) lasciando intatto il file", async () => {
    const target = join("/virtual-nonobj/kilo", "kilo.jsonc");
    const fs = createMemoryFs({ [target]: '["non-un-oggetto"]' });

    await expect(
      installProviderConfig({
        configDir: "/virtual-nonobj/kilo",
        iniPath: "/virtual-nonobj/missing.ini",
        readFile: fs.readFile,
        writeFile: fs.writeFile,
        exists: fs.exists,
        mkdir: fs.mkdir,
      }),
    ).rejects.toThrow(/atteso oggetto JSON.*file lasciato intatto/);

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.files.get(target)).toBe('["non-un-oggetto"]');
  });

  it("supporta BOM UTF-8 nel target esistente", async () => {
    const target = join("/virtual-bom/kilo", "kilo.jsonc");
    const fs = createMemoryFs({
      [target]: `\uFEFF{"model": "hexagon/custom"}`,
    });

    const res = await installProviderConfig({
      configDir: "/virtual-bom/kilo",
      iniPath: "/virtual-bom/missing.ini",
      readFile: fs.readFile,
      writeFile: fs.writeFile,
      exists: fs.exists,
      mkdir: fs.mkdir,
    });

    expect(res.updated).toBe(true);
    expect(JSON.parse(fs.files.get(target)!).model).toBe("hexagon/custom");
  });

  it("funziona su filesystem reale isolato con mkdtempSync (creazione dir, backup e rifiuto)", async () => {
    const tempRoot = makeTempDir("hexagon-config-");
    const nestedDir = join(tempRoot, "nested", "kilo");
    const iniPath = join(tempRoot, "hexagon-models.ini");
    writeFileSync(
      iniPath,
      "[Ornith-1.5-9B-Q4_0]\nmodel = m.gguf\ndevice = HTP0\nctx-size = 65536\n",
      "utf-8",
    );

    // 1. Prima creazione in directory non ancora esistente (testa mkdirSync reale)
    const first = await installProviderConfig({
      configDir: nestedDir,
      iniPath,
    });
    expect(first.updated).toBe(true);
    expect(first.backupPath).toBeUndefined();
    expect(existsSync(first.targetPath)).toBe(true);

    // 2. Aggiornamento successivo crea backup timestamped
    const rawWithComment = `{\n  // commento\n  "$schema": "https://app.kilo.ai/config.json",\n  "model": "hexagon/custom"\n}\n`;
    writeFileSync(first.targetPath, rawWithComment, "utf-8");

    const second = await installProviderConfig({
      configDir: nestedDir,
      iniPath,
      now: () => new Date(2026, 10, 25, 12, 0, 0).getTime(),
    });
    expect(second.backupPath).toBe(`${first.targetPath}.bak-20261125-120000`);
    expect(readFileSync(second.backupPath!, "utf-8")).toBe(rawWithComment);
    expect(JSON.parse(readFileSync(second.targetPath, "utf-8")).model).toBe("hexagon/custom");

    // 3. File corrotto sul disco reale: rifiuto senza toccare il file
    const corruptDir = join(tempRoot, "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    const corruptTarget = join(corruptDir, "kilo.json");
    writeFileSync(corruptTarget, "{ broken", "utf-8");

    await expect(
      installProviderConfig({ configDir: corruptDir, iniPath }),
    ).rejects.toThrow(/non parsabile/);
    expect(readFileSync(corruptTarget, "utf-8")).toBe("{ broken");
  });
});
