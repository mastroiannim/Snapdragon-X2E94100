import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackUrl,
  parseAgentFrontmatter,
  validateAgentConfig,
  validateKiloAgents,
  validateKiloConfig,
  validatePermissionConfig,
} from "../src/validate.js";

const tempRoots: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function validConfigObject() {
  return {
    $schema: "https://app.kilo.ai/config.json",
    plugin: ["./plugins/hexagon-runtime"],
    provider: {
      hexagon: {
        name: "Hexagon Local Runtime",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "http://127.0.0.1:18803/v1",
          apiKey: "local",
        },
        models: {
          "Ornith-1.5-9B-Q4_0": {
            name: "Ornith-1.5-9B-Q4_0 (HTP0)",
            limit: { context: 65536, output: 16384 },
          },
        },
      },
    },
    model: "hexagon/Ornith-1.5-9B-Q4_0",
    small_model: "hexagon/MiniCPM5-2B-Q4_K_M",
    permission: {
      read: { "*": "allow" },
      edit: { "*": "ask" },
      write: { "*": "ask" },
      bash: { "*": "ask", "git status *": "allow" },
      task: "ask",
    },
  };
}

describe("isLoopbackUrl", () => {
  it("accetta solo HTTP su 127.0.0.1, localhost o ::1", () => {
    expect(isLoopbackUrl("http://127.0.0.1:18803/v1")).toBe(true);
    expect(isLoopbackUrl("http://localhost:18803/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:18803/v1")).toBe(true);
    expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLoopbackUrl("http://localhost.evil.com/v1")).toBe(false);
    expect(isLoopbackUrl("https://127.0.0.1:18803/v1")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
  });
});

describe("validatePermissionConfig", () => {
  it("rifiuta permessi permissivi o malformati", () => {
    expect(validatePermissionConfig("allow", "kilo.json")).toContain(
      "Permesso globale impostato su allow (deve essere ask per sicurezza).",
    );
    expect(validatePermissionConfig("permit", "kilo.json")[0]).toContain("azione permission non valida");
    expect(validatePermissionConfig(123, "kilo.json")[0]).toContain("deve essere stringa o oggetto");
    expect(validatePermissionConfig({ __originalKeys: ["edit"] }, "kilo.json")).toEqual([]);
    expect(validatePermissionConfig({ __originalKeys: [123] }, "kilo.json")[0]).toContain("__originalKeys");
    expect(validatePermissionConfig({ bash: "allow" }, "kilo.json")[0]).toContain("Permesso bash");
    expect(validatePermissionConfig({ read: "nope" }, "kilo.json")[0]).toContain("permission.read");
    expect(validatePermissionConfig({ edit: {} }, "kilo.json")[0]).toContain("non puo' essere vuoto");
    expect(validatePermissionConfig({ edit: { "*": "allow" } }, "kilo.json")[0]).toContain("Permesso edit");
    expect(validatePermissionConfig({ edit: { "": "nope" } }, "kilo.json")).toHaveLength(2);
    expect(validatePermissionConfig({ edit: 42 }, "kilo.json")[0]).toContain("permission.edit");
  });
});

describe("validateAgentConfig e parseAgentFrontmatter", () => {
  it("valida frontmatter YAML annidato e segnala errori sintattici", () => {
    const validMd = [
      "---",
      'name: "code"',
      "description: 'Agent: coding'",
      "mode: primary # inline comment",
      "model: hexagon/Ornith-1.5-9B-Q4_0",
      "steps: 10",
      "tools:",
      "  hexagon_status: true",
      "  hexagon_bench: false",
      "permission:",
      '  "read": allow',
      "  edit:",
      '    "*.md": allow',
      '    "*": ask',
      "---",
      "Prompt body",
    ].join("\n");
    const parsed = parseAgentFrontmatter(validMd, "code.md");
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter).toMatchObject({
      name: "code",
      description: "Agent: coding",
      mode: "primary",
      steps: 10,
      tools: { hexagon_status: true, hexagon_bench: false },
    });
    expect(validateAgentConfig(parsed.frontmatter, "code.md", true)).toEqual([]);

    expect(parseAgentFrontmatter("no frontmatter", "a.md").issues[0]).toContain("iniziale");
    expect(parseAgentFrontmatter("---\nname: a\n", "a.md").issues[0]).toContain("chiusura");
    expect(parseAgentFrontmatter("---\n\tname: a\n---", "a.md").issues[0]).toContain("tabulazione");
    expect(parseAgentFrontmatter("---\ninvalidline\n---", "a.md").issues[0]).toContain("non valida");
    expect(parseAgentFrontmatter("---\n: val\n---", "a.md").issues[0]).toContain("chiave YAML vuota");
    expect(parseAgentFrontmatter("---\nname: a\nname: b\n---", "a.md").issues[0]).toContain("duplicata");

    const edgeMd = [
      "\uFEFF---",
      "# comment line",
      'name: "quoted\\"esc"',
      "ratio: 1.5",
      "optional: ~",
      "disabled: false",
      "nested: # comment after empty value",
      "  sub: value",
      "---",
    ].join("\n");
    const edgeParsed = parseAgentFrontmatter(edgeMd, "edge.md");
    expect(edgeParsed.issues).toEqual([]);
    expect(edgeParsed.frontmatter).toMatchObject({
      name: 'quoted\\"esc',
      ratio: 1.5,
      optional: null,
      disabled: false,
      nested: { sub: "value" },
    });
  });

  it("valida vincoli AgentConfig", () => {
    expect(validateAgentConfig("bad", "x")[0]).toContain("deve essere un oggetto");
    const issues = validateAgentConfig(
      {
        permissions: { read: "allow" },
        mode: "invalid",
        model: "openai/gpt-4",
        tools: { a: "yes" },
        steps: 0,
      },
      "broken.md",
      true,
    );
    expect(issues.some((i) => i.includes("permissions"))).toBe(true);
    expect(issues.some((i) => i.includes("campo obbligatorio 'name'"))).toBe(true);
    expect(issues.some((i) => i.includes("mode 'invalid'"))).toBe(true);
    expect(issues.some((i) => i.includes("provider locale hexagon"))).toBe(true);
    expect(issues.some((i) => i.includes("'tools'"))).toBe(true);
    expect(issues.some((i) => i.includes("'steps'"))).toBe(true);
  });
});

describe("validateKiloConfig e validateKiloAgents", () => {
  it("valida la configurazione reale del repository (kilo.json + .kilo/agents)", async () => {
    const repoRoot = dirname(dirname(dirname(import.meta.dirname)));
    const repoKiloJson = join(repoRoot, "kilo.json");
    if (existsSync(repoKiloJson)) {
      const res = await validateKiloConfig(repoKiloJson);
      expect(res.issues).toEqual([]);
      expect(res.valid).toBe(true);
    }
  });

  it("rileva violazioni di schema e sicurezza offline", async () => {
    const root = makeTempDir("hexagon-validate-");
    const cfgPath = join(root, "kilo.json");

    expect((await validateKiloConfig(cfgPath)).valid).toBe(false);

    writeFileSync(cfgPath, "{ broken", "utf-8");
    expect((await validateKiloConfig(cfgPath)).issues[0]).toContain("parsing JSON");

    writeFileSync(cfgPath, "[]", "utf-8");
    expect((await validateKiloConfig(cfgPath)).issues[0]).toContain("oggetto JSON root");

    const bad = {
      ...validConfigObject(),
      $schema: "http://insecure.example/schema.json",
      plugin: "not-a-list",
      permissions: { edit: "ask" },
      model: "anthropic/claude-3-5-sonnet",
      small_model: "openai/gpt-4o-mini",
      agent: {
        bad: { mode: "unknown" },
      },
    };
    (bad.provider.hexagon as Record<string, unknown>).npm = "@ai-sdk/openai";
    (bad.provider.hexagon.options as Record<string, unknown>).baseURL = "https://api.openai.com/v1";
    (bad.provider.hexagon.models["Ornith-1.5-9B-Q4_0"].limit as Record<string, unknown>).context = -1;
    writeFileSync(cfgPath, JSON.stringify(bad), "utf-8");

    const res = await validateKiloConfig(cfgPath);
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.includes("permissions"))).toBe(true);
    expect(res.issues.some((i) => i.includes("$schema"))).toBe(true);
    expect(res.issues.some((i) => i.includes("'plugin'"))).toBe(true);
    expect(res.issues.some((i) => i.includes("loopback"))).toBe(true);
    expect(res.issues.some((i) => i.includes("non locale/OpenAI-compatible"))).toBe(true);
    expect(res.issues.some((i) => i.includes("context"))).toBe(true);
    expect(res.issues.some((i) => i.includes("model non punta"))).toBe(true);
    expect(res.issues.some((i) => i.includes("small_model non punta"))).toBe(true);
    expect(res.issues.some((i) => i.includes("kilo.json:agent.bad"))).toBe(true);
  });

  it("valida .kilo/agents/*.md su filesystem reale e segnala directory mancanti o vuote", async () => {
    const root = makeTempDir("hexagon-agents-");
    const agentsDir = join(root, ".kilo", "agents");
    expect((await validateKiloAgents(agentsDir)).valid).toBe(false);

    mkdirSync(agentsDir, { recursive: true });
    expect((await validateKiloAgents(agentsDir)).issues[0]).toContain("Nessun file agente");

    writeFileSync(
      join(agentsDir, "broken.md"),
      "---\nname: broken\ndescription: Broken\nmode: primary\npermissions:\n  read: allow\n---\nBody\n",
      "utf-8",
    );
    writeFileSync(join(root, "kilo.json"), JSON.stringify(validConfigObject()), "utf-8");

    const res = await validateKiloConfig(join(root, "kilo.json"));
    expect(res.valid).toBe(false);
    expect(res.issues.some((i) => i.includes("permissions"))).toBe(true);
  });

  it("gestisce errori provider/models/agent/listDir/readFile nei dettagli", async () => {
    const res1 = await validateKiloConfig("/virtual/kilo.json", {
      exists: async () => true,
      readFile: async () =>
        JSON.stringify({
          provider: {
            bad: "not-obj",
            noOpts: { npm: "@ai-sdk/openai-compatible", models: "bad" },
            badModels: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: "http://127.0.0.1:18803/v1" },
              models: { m: "not-obj" },
            },
          },
          agent: "not-obj",
        }),
      isDirectory: async () => false,
    });
    expect(res1.valid).toBe(false);
    expect(res1.issues.some((i) => i.includes("Provider bad deve essere"))).toBe(true);
    expect(res1.issues.some((i) => i.includes("richiede oggetto 'options'"))).toBe(true);
    expect(res1.issues.some((i) => i.includes("noOpts.models"))).toBe(true);
    expect(res1.issues.some((i) => i.includes("badModels.models.m"))).toBe(true);
    expect(res1.issues.some((i) => i.includes("Campo 'agent'"))).toBe(true);

    const res2 = await validateKiloConfig("/virtual/empty-prov.json", {
      exists: async () => true,
      readFile: async () => JSON.stringify({ provider: {} }),
      isDirectory: async () => false,
    });
    expect(res2.issues.some((i) => i.includes("Nessun provider configurato"))).toBe(true);

    const agentListErr = await validateKiloAgents("/virtual/agents", {
      isDirectory: async () => true,
      listDir: async () => {
        throw new Error("EACCES");
      },
    });
    expect(agentListErr.issues[0]).toContain("Impossibile leggere");

    const agentReadErr = await validateKiloAgents("/virtual/agents", {
      isDirectory: async () => true,
      listDir: async () => ["a.md"],
      readFile: async () => {
        throw new Error("read denied");
      },
    });
    expect(agentReadErr.issues[0]).toContain("impossibile leggere il file");
  });
});
