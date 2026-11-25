/**
 * validate.ts — Validatore nativo TypeScript per kilo.json e .kilo/agents/*.md.
 *
 * Sostituisce kilo_config.py --check garantendo conformita' dello schema Kilo Code
 * e vincoli di sicurezza offline (endpoint loopback obbligatorio, provider locale
 * @ai-sdk/openai-compatible, permessi sicuri su edit/write/bash).
 */
import { dirname, join } from "node:path";
import { stripJsonComments } from "./config.js";
import { nodeExists, nodeIsDirectory, nodeListDir, nodeReadFile } from "./os.js";
import type { ExistsFn, IsDirFn, ListDirFn, ReadFileFn } from "./types.js";

export const VALID_PERMISSION_ACTIONS = new Set(["ask", "allow", "deny"]);
export const VALID_AGENT_MODES = new Set(["primary", "subagent", "all"]);
export const SENSITIVE_PERMISSION_TOOLS = new Set(["edit", "write", "bash"]);
export const FORBIDDEN_PLURAL_KEYS: Readonly<Record<string, string>> = {
  permissions: "permission",
  providers: "provider",
  plugins: "plugin",
  agents: "agent",
};

export interface ValidateDeps {
  exists?: ExistsFn;
  readFile?: ReadFileFn;
  listDir?: ListDirFn;
  isDirectory?: IsDirFn;
}

export interface AgentValidationResult {
  valid: boolean;
  issues: string[];
}

export interface ValidationResult {
  valid: boolean;
  configPath: string;
  issues: string[];
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function isPositiveInt(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val > 0;
}

/** Verifica che l'URL usi protocollo HTTP e punti rigorosamente a loopback. */
export function isLoopbackUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** Valida la struttura PermissionConfig secondo lo schema Kilo e le regole offline. */
export function validatePermissionConfig(
  perms: unknown,
  sourceLabel: string,
  requireSafeDefaults = true,
): string[] {
  const issues: string[] = [];
  if (typeof perms === "string") {
    if (!VALID_PERMISSION_ACTIONS.has(perms)) {
      issues.push(
        `${sourceLabel}: azione permission non valida '${perms}' (atteso uno di allow, ask, deny).`,
      );
    } else if (requireSafeDefaults && perms === "allow") {
      issues.push("Permesso globale impostato su allow (deve essere ask per sicurezza).");
    }
    return issues;
  }

  if (!isPlainObject(perms)) {
    issues.push(`${sourceLabel}: 'permission' deve essere stringa o oggetto.`);
    return issues;
  }

  for (const [toolName, rule] of Object.entries(perms)) {
    if (toolName === "__originalKeys") {
      if (!Array.isArray(rule) || !rule.every((k) => typeof k === "string")) {
        issues.push(`${sourceLabel}: permission.__originalKeys deve essere una lista di stringhe.`);
      }
      continue;
    }

    if (typeof rule === "string") {
      if (!VALID_PERMISSION_ACTIONS.has(rule)) {
        issues.push(
          `${sourceLabel}: azione permission.${toolName} non valida '${rule}' (atteso uno di allow, ask, deny).`,
        );
      } else if (
        requireSafeDefaults &&
        SENSITIVE_PERMISSION_TOOLS.has(toolName) &&
        rule === "allow"
      ) {
        issues.push(
          `Permesso ${toolName} globale impostato su allow (deve essere ask per sicurezza).`,
        );
      }
    } else if (isPlainObject(rule)) {
      const entries = Object.entries(rule);
      if (entries.length === 0) {
        issues.push(`${sourceLabel}: permission.${toolName} non puo' essere vuoto.`);
      }
      for (const [pattern, action] of entries) {
        if (typeof pattern !== "string" || !pattern) {
          issues.push(`${sourceLabel}: pattern permission.${toolName} non valido: ${String(pattern)}.`);
        }
        if (typeof action !== "string" || !VALID_PERMISSION_ACTIONS.has(action)) {
          issues.push(
            `${sourceLabel}: azione permission.${toolName}[${JSON.stringify(pattern)}] non valida: ${String(action)}.`,
          );
        }
      }
      if (
        requireSafeDefaults &&
        SENSITIVE_PERMISSION_TOOLS.has(toolName) &&
        rule["*"] === "allow"
      ) {
        issues.push(
          `Permesso ${toolName} globale ('*') impostato su allow (deve essere ask per sicurezza).`,
        );
      }
    } else {
      issues.push(
        `${sourceLabel}: permission.${toolName} deve essere stringa ('ask'|'allow'|'deny') o oggetto.`,
      );
    }
  }
  return issues;
}

/** Valida uno schema AgentConfig (in kilo.json o frontmatter .kilo/agents/*.md). */
export function validateAgentConfig(
  agentCfg: unknown,
  sourceLabel: string,
  requireFields = false,
): string[] {
  const issues: string[] = [];
  if (!isPlainObject(agentCfg)) {
    return [`${sourceLabel}: configurazione agente deve essere un oggetto.`];
  }

  if ("permissions" in agentCfg) {
    issues.push(
      `${sourceLabel}: chiave schema non valida 'permissions' (usare 'permission' al singolare).`,
    );
  }

  if (requireFields) {
    for (const req of ["name", "description", "mode"] as const) {
      const val = agentCfg[req];
      if (typeof val !== "string" || !val.trim()) {
        issues.push(`${sourceLabel}: campo obbligatorio '${req}' mancante o non valido.`);
      }
    }
    if (!("permission" in agentCfg)) {
      issues.push(`${sourceLabel}: campo obbligatorio 'permission' mancante.`);
    }
  }

  if ("mode" in agentCfg) {
    const mode = agentCfg.mode;
    if (typeof mode !== "string" || !VALID_AGENT_MODES.has(mode)) {
      issues.push(
        `${sourceLabel}: mode '${String(mode)}' non valido (atteso uno di all, primary, subagent).`,
      );
    }
  }

  if ("model" in agentCfg) {
    const model = agentCfg.model;
    if (typeof model !== "string" || !model.startsWith("hexagon/")) {
      issues.push(`${sourceLabel}: model '${String(model)}' non punta al provider locale hexagon.`);
    }
  }

  if ("tools" in agentCfg) {
    const tools = agentCfg.tools;
    if (
      !isPlainObject(tools) ||
      !Object.values(tools).every((v) => typeof v === "boolean")
    ) {
      issues.push(`${sourceLabel}: 'tools' deve essere un dizionario chiave -> booleano.`);
    }
  }

  if ("steps" in agentCfg && !isPositiveInt(agentCfg.steps)) {
    issues.push(`${sourceLabel}: 'steps' deve essere un intero positivo.`);
  }

  if ("permission" in agentCfg) {
    issues.push(...validatePermissionConfig(agentCfg.permission, sourceLabel, true));
  }

  return issues;
}

function unquoteYamlToken(token: string): { text: string; wasQuoted: boolean } {
  const s = token.trim();
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return { text: s.slice(1, -1), wasQuoted: true };
  }
  return { text: s, wasQuoted: false };
}

function stripYamlInlineComment(value: string): string {
  let inQuote: string | null = null;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inQuote === '"') {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (inQuote === null) inQuote = ch;
      else if (inQuote === ch) inQuote = null;
      continue;
    }
    if (ch === "#" && inQuote === null && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trim();
}

function parseYamlScalar(rawVal: string): unknown {
  const cleaned = stripYamlInlineComment(rawVal);
  const { text, wasQuoted } = unquoteYamlToken(cleaned);
  if (wasQuoted) return text;
  const lower = text.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (lower === "null" || lower === "~") return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text);
  return text;
}

/** Estrae e valida la sintassi YAML del frontmatter in .kilo/agents/*.md. */
export function parseAgentFrontmatter(
  rawText: string,
  fileName: string,
): { frontmatter: Record<string, unknown> | null; issues: string[] } {
  const noBom = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const lines = noBom.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return {
      frontmatter: null,
      issues: [`${fileName}: frontmatter YAML iniziale '---' mancante.`],
    };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    return {
      frontmatter: null,
      issues: [`${fileName}: delimitatore di chiusura frontmatter '---' mancante.`],
    };
  }

  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; map: Record<string, unknown> }> = [
    { indent: -1, map: root },
  ];

  for (let idx = 1; idx < endIdx; idx++) {
    const lineNo = idx + 1;
    const rawLine = lines[idx];
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith("#")) continue;

    const leadingLen = rawLine.length - rawLine.trimStart().length;
    const leading = rawLine.slice(0, leadingLen);
    if (leading.includes("\t")) {
      return {
        frontmatter: null,
        issues: [`${fileName}:${lineNo}: tabulazione non ammessa nel frontmatter YAML.`],
      };
    }
    const indent = leading.length;

    let inQuote: string | null = null;
    let colonIdx = -1;
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '"' || ch === "'") {
        if (inQuote === null) inQuote = ch;
        else if (inQuote === ch) inQuote = null;
      } else if (ch === ":" && inQuote === null) {
        if (i + 1 === stripped.length || /\s/.test(stripped[i + 1])) {
          colonIdx = i;
          break;
        }
      }
    }
    if (colonIdx < 0) {
      return {
        frontmatter: null,
        issues: [`${fileName}:${lineNo}: riga YAML non valida '${stripped}'.`],
      };
    }

    const { text: key } = unquoteYamlToken(stripped.slice(0, colonIdx));
    if (!key) {
      return {
        frontmatter: null,
        issues: [`${fileName}:${lineNo}: chiave YAML vuota.`],
      };
    }
    const rawVal = stripped.slice(colonIdx + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].map;
    if (Object.prototype.hasOwnProperty.call(parent, key)) {
      return {
        frontmatter: null,
        issues: [`${fileName}:${lineNo}: chiave YAML duplicata '${key}'.`],
      };
    }

    if (rawVal === "" || rawVal.startsWith("#")) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, map: child });
    } else {
      parent[key] = parseYamlScalar(rawVal);
    }
  }

  return { frontmatter: root, issues: [] };
}

/** Valida lo schema di tutti gli agenti markdown in .kilo/agents/. */
export async function validateKiloAgents(
  agentsDir: string,
  deps: ValidateDeps = {},
): Promise<AgentValidationResult> {
  const isDirectory = deps.isDirectory ?? nodeIsDirectory;
  const listDir = deps.listDir ?? nodeListDir;
  const readFile = deps.readFile ?? nodeReadFile;

  if (!(await isDirectory(agentsDir))) {
    return { valid: false, issues: [`Directory agenti ${agentsDir} mancante.`] };
  }

  let entries: string[];
  try {
    entries = await listDir(agentsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, issues: [`Impossibile leggere ${agentsDir}: ${msg}`] };
  }

  const mdFiles = entries.filter((f) => f.toLowerCase().endsWith(".md")).sort();
  if (mdFiles.length === 0) {
    return { valid: false, issues: [`Nessun file agente .md trovato in ${agentsDir}.`] };
  }

  const issues: string[] = [];
  for (const fileName of mdFiles) {
    const mdPath = join(agentsDir, fileName);
    let rawText: string;
    try {
      rawText = await readFile(mdPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`${fileName}: impossibile leggere il file (${msg}).`);
      continue;
    }
    const { frontmatter, issues: parseIssues } = parseAgentFrontmatter(rawText, fileName);
    if (parseIssues.length > 0 || !frontmatter) {
      issues.push(...parseIssues);
      continue;
    }
    issues.push(...validateAgentConfig(frontmatter, fileName, true));
  }

  return { valid: issues.length === 0, issues };
}

/** Verifica schema Kilo e vincoli di sicurezza offline su kilo.json e .kilo/agents. */
export async function validateKiloConfig(
  configPath: string,
  deps: ValidateDeps = {},
): Promise<ValidationResult> {
  const exists = deps.exists ?? nodeExists;
  const readFile = deps.readFile ?? nodeReadFile;
  const isDirectory = deps.isDirectory ?? nodeIsDirectory;

  if (!(await exists(configPath))) {
    return { valid: false, configPath, issues: [`File ${configPath} mancante.`] };
  }

  let raw: string;
  let parsed: unknown;
  try {
    raw = await readFile(configPath);
    const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(stripJsonComments(noBom));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, configPath, issues: [`Errore parsing JSON: ${msg}`] };
  }

  if (!isPlainObject(parsed)) {
    return {
      valid: false,
      configPath,
      issues: ["Schema kilo.json non valido: atteso oggetto JSON root."],
    };
  }

  const issues: string[] = [];

  for (const [badKey, expectedKey] of Object.entries(FORBIDDEN_PLURAL_KEYS)) {
    if (badKey in parsed) {
      issues.push(
        `Chiave schema non valida '${badKey}' in kilo.json: usare '${expectedKey}'.`,
      );
    }
  }

  if ("$schema" in parsed) {
    const schemaVal = parsed.$schema;
    if (typeof schemaVal !== "string" || !schemaVal.startsWith("https://")) {
      issues.push(`Campo '$schema' non valido in kilo.json: ${String(schemaVal)}`);
    }
  }

  if ("plugin" in parsed) {
    const plugins = parsed.plugin;
    if (
      !Array.isArray(plugins) ||
      !plugins.every((p) => typeof p === "string" && p.trim().length > 0)
    ) {
      issues.push("Campo 'plugin' in kilo.json deve essere una lista di stringhe non vuote.");
    }
  }

  const providers = parsed.provider;
  if (!isPlainObject(providers) || Object.keys(providers).length === 0) {
    issues.push("Nessun provider configurato (atteso oggetto non vuoto).");
  } else {
    for (const [pname, pcfg] of Object.entries(providers)) {
      if (!isPlainObject(pcfg)) {
        issues.push(`Provider ${pname} deve essere un oggetto JSON.`);
        continue;
      }
      const opts = pcfg.options;
      const baseUrl = isPlainObject(opts) ? opts.baseURL : "";
      if (!isPlainObject(opts)) {
        issues.push(`Provider ${pname} richiede oggetto 'options'.`);
      }
      if (typeof baseUrl !== "string" || !isLoopbackUrl(baseUrl)) {
        issues.push(`Provider ${pname} baseURL non punta a loopback: ${String(baseUrl)}`);
      }
      const npmPkg = typeof pcfg.npm === "string" ? pcfg.npm : "";
      if (npmPkg !== "@ai-sdk/openai-compatible") {
        issues.push(
          `Provider ${pname} utilizza pacchetto non locale/OpenAI-compatible: ${npmPkg}`,
        );
      }
      if ("models" in pcfg) {
        const models = pcfg.models;
        if (!isPlainObject(models)) {
          issues.push(`Provider ${pname}.models deve essere un oggetto JSON.`);
        } else {
          for (const [mid, mcfg] of Object.entries(models)) {
            if (!isPlainObject(mcfg)) {
              issues.push(`Provider ${pname}.models.${mid} deve essere un oggetto JSON.`);
              continue;
            }
            if ("limit" in mcfg) {
              const lim = mcfg.limit;
              if (
                !isPlainObject(lim) ||
                !isPositiveInt(lim.context) ||
                !isPositiveInt(lim.output)
              ) {
                issues.push(
                  `Provider ${pname}.models.${mid}.limit richiede 'context' e 'output' interi positivi.`,
                );
              }
            }
          }
        }
      }
    }
  }

  const model = parsed.model;
  if (typeof model !== "string" || !model.startsWith("hexagon/")) {
    issues.push(`model non punta al provider locale hexagon: ${String(model)}`);
  }

  const smallModel = parsed.small_model;
  if (typeof smallModel !== "string" || !smallModel.startsWith("hexagon/")) {
    issues.push(`small_model non punta al provider locale hexagon: ${String(smallModel)}`);
  }

  if ("permission" in parsed) {
    issues.push(...validatePermissionConfig(parsed.permission, "kilo.json", true));
  }

  if ("agent" in parsed) {
    const agentsCfg = parsed.agent;
    if (!isPlainObject(agentsCfg)) {
      issues.push("Campo 'agent' in kilo.json deve essere un oggetto JSON.");
    } else {
      for (const [agentName, agentVal] of Object.entries(agentsCfg)) {
        issues.push(...validateAgentConfig(agentVal, `kilo.json:agent.${agentName}`, false));
      }
    }
  }

  const agentsDir = join(dirname(configPath), ".kilo", "agents");
  if (await isDirectory(agentsDir)) {
    const agentRes = await validateKiloAgents(agentsDir, deps);
    issues.push(...agentRes.issues);
  }

  return { valid: issues.length === 0, configPath, issues };
}
