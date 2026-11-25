#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Configuratore e sincronizzatore per Kilo Code su runtime Hexagon GGUF.

Genera e valida kilo.json mappando i preset hardware di hexagon-models.ini
e gli ID restituiti dall'endpoint locale OpenAI-compatibile.
"""

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

VALID_PERMISSION_ACTIONS = {"ask", "allow", "deny"}
VALID_AGENT_MODES = {"primary", "subagent", "all"}
SENSITIVE_PERMISSION_TOOLS = {"edit", "write", "bash"}
FORBIDDEN_PLURAL_KEYS = {
    "permissions": "permission",
    "providers": "provider",
    "plugins": "plugin",
    "agents": "agent",
}

DEFAULT_PORT = 18803
DEFAULT_BASE_URL = f"http://127.0.0.1:{DEFAULT_PORT}/v1"
DEFAULT_WORKSPACE = Path(__file__).resolve().parent

# Modelli verificati e raccomandati
RECOMMENDED_MAIN_MODEL = "Ornith-1.5-9B-Q4_0"
RECOMMENDED_SMALL_MODEL = "MiniCPM5-2B-Q4_K_M"

# Config globale di Kilo Code CLI (da `kilo debug paths`)
GLOBAL_CONFIG_NAME = "kilo.jsonc"


def parse_hexagon_models_ini(ini_path: Path) -> Dict[str, Dict[str, Any]]:
    """Estrae i metadati dei modelli da hexagon-models.ini."""
    presets = {}
    if not ini_path.is_file():
        return presets

    current_section = None
    with open(ini_path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line.startswith("[") and line.endswith("]"):
                current_section = line[1:-1].strip()
                presets.setdefault(current_section, {})
            elif current_section and "=" in line:
                key, val = line.split("=", 1)
                presets[current_section][key.strip()] = val.strip()

    defaults = presets.pop("*", {})
    resolved = {name: {**defaults, **values} for name, values in presets.items()}

    models = {}
    for alias, sec_dict in resolved.items():
        ctx_size = int(sec_dict.get("ctx-size", 4096))
        device = sec_dict.get("device", "CPU")
        tensor_split = sec_dict.get("tensor-split")

        models[alias] = {
            "model_path": sec_dict.get("model", ""),
            "device": device,
            "tensor_split": tensor_split,
            "ctx_size": ctx_size,
        }
    return models


def fetch_live_models(base_url: str = DEFAULT_BASE_URL) -> List[str]:
    """Interroga /v1/models del router se attivo."""
    try:
        resp = httpx.get(f"{base_url}/models", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            return [m["id"] for m in data.get("data", []) if "id" in m]
    except (httpx.HTTPError, OSError, ValueError):
        pass
    return []


def generate_kilo_config(
    workspace_dir: Path = DEFAULT_WORKSPACE,
    base_url: str = DEFAULT_BASE_URL,
    preferred_model: Optional[str] = None,
    preferred_small_model: Optional[str] = None,
) -> Dict[str, Any]:
    """Costruisce la configurazione kilo.json rigorosamente locale."""
    ini_path = workspace_dir / "hexagon-models.ini"
    ini_models = parse_hexagon_models_ini(ini_path)
    live_models = fetch_live_models(base_url)

    # Determina l'insieme di modelli disponibili
    available_ids = list(ini_models.keys())
    if live_models:
        # Intersezione o unione ordinata
        for mid in live_models:
            if mid not in available_ids:
                available_ids.append(mid)

    models_config = {}
    for mid in available_ids:
        meta = ini_models.get(mid, {})
        ctx_size = meta.get("ctx_size", 65536)
        device = meta.get("device", "HTP0")
        output_limit = min(16384, ctx_size // 4) if ctx_size > 8192 else max(1024, ctx_size // 2)

        models_config[mid] = {
            "name": f"{mid} ({device})",
            "limit": {
                "context": ctx_size,
                "output": output_limit,
            },
        }

    # Selezione del modello principale e small model
    main_id = preferred_model or (
        RECOMMENDED_MAIN_MODEL if RECOMMENDED_MAIN_MODEL in models_config
        else (available_ids[0] if available_ids else "default")
    )
    small_id = preferred_small_model or (
        RECOMMENDED_SMALL_MODEL if RECOMMENDED_SMALL_MODEL in models_config
        else main_id
    )

    config: Dict[str, Any] = {
        "$schema": "https://app.kilo.ai/config.json",
    }
    plugin_path = workspace_dir / "plugins" / "hexagon-runtime"
    if plugin_path.is_dir():
        config["plugin"] = ["./plugins/hexagon-runtime"]

    config.update({
        "provider": {
            "hexagon": {
                "name": "Hexagon Local Runtime",
                "npm": "@ai-sdk/openai-compatible",
                "options": {
                    "baseURL": base_url,
                    "apiKey": "local",
                },
                "models": models_config,
            }
        },
        "model": f"hexagon/{main_id}",
        "small_model": f"hexagon/{small_id}",
        "permission": {
            "read": {
                "*": "allow"
            },
            "edit": {
                "*": "ask"
            },
            "write": {
                "*": "ask"
            },
            "bash": {
                "*": "ask",
                "git status *": "allow",
                "git diff *": "allow",
                "git log *": "allow"
            },
            "task": "ask",
            "external_directory": "ask"
        }
    })
    return config


def write_kilo_config(workspace_dir: Path = DEFAULT_WORKSPACE, config: Optional[Dict[str, Any]] = None) -> Path:
    """Scrive kilo.json nel workspace in formato UTF-8."""
    if config is None:
        config = generate_kilo_config(workspace_dir)

    target = workspace_dir / "kilo.json"
    with open(target, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return target


def global_config_path(config_dir: Optional[Path] = None) -> Path:
    """Risolve il percorso del config globale di Kilo Code CLI."""
    root = Path(config_dir) if config_dir is not None else Path.home() / ".config" / "kilo"
    return root / GLOBAL_CONFIG_NAME


def install_global_provider(
    workspace_dir: Path = DEFAULT_WORKSPACE,
    config_dir: Optional[Path] = None,
) -> Tuple[Path, bool, List[str]]:
    """Installa (o aggiorna) il provider 'hexagon' nel config globale di Kilo.

    Necessario per avviare `kilo <cartella>` su progetti fuori dal workspace
    Hexagon: Kilo risolve kilo.json risalendo dalla cartella del progetto e,
    se non lo trova, ricade sul config globale (~/.config/kilo/kilo.jsonc).
    Il file esistente viene preservato e backuppato con timestamp; se non e'
    parsabile come JSON la funzione non tocca nulla e segnala l'errore.
    """
    config = generate_kilo_config(workspace_dir)
    hexagon = config["provider"]["hexagon"]

    target = global_config_path(config_dir)
    existing: Dict[str, Any] = {}
    if target.is_file():
        try:
            with open(target, "r", encoding="utf-8-sig") as f:
                existing = json.load(f)
        except (OSError, ValueError) as exc:
            return target, False, [f"Config globale {target} non parsabile ({exc}); file lasciato intatto."]

    providers = existing.get("provider")
    if not isinstance(providers, dict):
        providers = {}
    if providers.get("hexagon") == hexagon:
        return target, False, []

    merged = dict(existing)
    merged["provider"] = {**providers, "hexagon": hexagon}

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_file():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = target.with_name(f"{target.name}.bak-{stamp}")
            shutil.copy2(target, backup)
        with open(target, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except OSError as exc:
        return target, False, [f"Scrittura config globale fallita: {exc}"]

    return target, True, []


def _is_positive_int(val: Any) -> bool:
    return isinstance(val, int) and not isinstance(val, bool) and val > 0


def _validate_permission_config(
    perms: Any,
    source_label: str,
    require_safe_defaults: bool = True,
) -> List[str]:
    """Valida la struttura PermissionConfig secondo lo schema Kilo."""
    issues: List[str] = []
    if isinstance(perms, str):
        if perms not in VALID_PERMISSION_ACTIONS:
            issues.append(
                f"{source_label}: azione permission non valida '{perms}' "
                f"(atteso uno di {sorted(VALID_PERMISSION_ACTIONS)})."
            )
        elif require_safe_defaults and perms == "allow":
            issues.append("Permesso globale impostato su allow (deve essere ask per sicurezza).")
        return issues

    if not isinstance(perms, dict):
        issues.append(f"{source_label}: 'permission' deve essere stringa o oggetto.")
        return issues

    for tool_name, rule in perms.items():
        if tool_name == "__originalKeys":
            if not isinstance(rule, list) or not all(isinstance(k, str) for k in rule):
                issues.append(f"{source_label}: permission.__originalKeys deve essere una lista di stringhe.")
            continue
        if isinstance(rule, str):
            if rule not in VALID_PERMISSION_ACTIONS:
                issues.append(
                    f"{source_label}: azione permission.{tool_name} non valida '{rule}' "
                    f"(atteso uno di {sorted(VALID_PERMISSION_ACTIONS)})."
                )
            elif require_safe_defaults and tool_name in SENSITIVE_PERMISSION_TOOLS and rule == "allow":
                issues.append(
                    f"Permesso {tool_name} globale impostato su allow (deve essere ask per sicurezza)."
                )
        elif isinstance(rule, dict):
            if not rule:
                issues.append(f"{source_label}: permission.{tool_name} non puo' essere vuoto.")
            for pattern, action in rule.items():
                if not isinstance(pattern, str) or not pattern:
                    issues.append(f"{source_label}: pattern permission.{tool_name} non valido: {pattern!r}.")
                if not isinstance(action, str) or action not in VALID_PERMISSION_ACTIONS:
                    issues.append(
                        f"{source_label}: azione permission.{tool_name}[{pattern!r}] non valida: {action!r}."
                    )
            if require_safe_defaults and tool_name in SENSITIVE_PERMISSION_TOOLS and rule.get("*") == "allow":
                issues.append(
                    f"Permesso {tool_name} globale ('*') impostato su allow (deve essere ask per sicurezza)."
                )
        else:
            issues.append(
                f"{source_label}: permission.{tool_name} deve essere stringa ('ask'|'allow'|'deny') o oggetto."
            )
    return issues


def _validate_agent_dict(
    agent_cfg: Any,
    source_label: str,
    require_fields: bool = False,
) -> List[str]:
    """Valida uno schema AgentConfig (in kilo.json o frontmatter .kilo/agents/*.md)."""
    issues: List[str] = []
    if not isinstance(agent_cfg, dict):
        return [f"{source_label}: configurazione agente deve essere un oggetto."]

    if "permissions" in agent_cfg:
        issues.append(
            f"{source_label}: chiave schema non valida 'permissions' (usare 'permission' al singolare)."
        )

    if require_fields:
        for req in ("name", "description", "mode"):
            val = agent_cfg.get(req)
            if not isinstance(val, str) or not val.strip():
                issues.append(f"{source_label}: campo obbligatorio '{req}' mancante o non valido.")
        if "permission" not in agent_cfg:
            issues.append(f"{source_label}: campo obbligatorio 'permission' mancante.")

    if "mode" in agent_cfg:
        mode = agent_cfg["mode"]
        if not isinstance(mode, str) or mode not in VALID_AGENT_MODES:
            issues.append(
                f"{source_label}: mode '{mode}' non valido (atteso uno di {sorted(VALID_AGENT_MODES)})."
            )

    if "model" in agent_cfg:
        model = agent_cfg["model"]
        if not isinstance(model, str) or not model.startswith("hexagon/"):
            issues.append(f"{source_label}: model '{model}' non punta al provider locale hexagon.")

    if "tools" in agent_cfg:
        tools = agent_cfg["tools"]
        if not isinstance(tools, dict) or not all(
            isinstance(k, str) and isinstance(v, bool) for k, v in tools.items()
        ):
            issues.append(f"{source_label}: 'tools' deve essere un dizionario chiave -> booleano.")

    if "steps" in agent_cfg and not _is_positive_int(agent_cfg["steps"]):
        issues.append(f"{source_label}: 'steps' deve essere un intero positivo.")

    if "permission" in agent_cfg:
        issues.extend(_validate_permission_config(agent_cfg["permission"], source_label, require_safe_defaults=True))

    return issues


def _unquote_yaml_token(token: str) -> Tuple[str, bool]:
    s = token.strip()
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        return s[1:-1], True
    return s, False


def _strip_yaml_inline_comment(value: str) -> str:
    in_quote: Optional[str] = None
    escaped = False
    for idx, ch in enumerate(value):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_quote == '"':
            escaped = True
            continue
        if ch in ('"', "'"):
            if in_quote is None:
                in_quote = ch
            elif in_quote == ch:
                in_quote = None
            continue
        if ch == "#" and in_quote is None and (idx == 0 or value[idx - 1].isspace()):
            return value[:idx].rstrip()
    return value.strip()


def _parse_yaml_scalar(raw_val: str) -> Any:
    cleaned = _strip_yaml_inline_comment(raw_val)
    text, was_quoted = _unquote_yaml_token(cleaned)
    if was_quoted:
        return text
    lower = text.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower in ("null", "~"):
        return None
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    return text


def _parse_agent_frontmatter(md_path: Path) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """Estrae e valida la sintassi YAML del frontmatter in .kilo/agents/*.md."""
    try:
        raw_text = md_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return None, [f"{md_path.name}: impossibile leggere il file ({exc})."]

    lines = raw_text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, [f"{md_path.name}: frontmatter YAML iniziale '---' mancante."]

    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, [f"{md_path.name}: delimitatore di chiusura frontmatter '---' mancante."]

    root: Dict[str, Any] = {}
    stack: List[Tuple[int, Dict[str, Any]]] = [(-1, root)]

    for line_no, raw_line in enumerate(lines[1:end_idx], start=2):
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        leading = raw_line[: len(raw_line) - len(raw_line.lstrip(" \t"))]
        if "\t" in leading:
            return None, [f"{md_path.name}:{line_no}: tabulazione non ammessa nel frontmatter YAML."]
        indent = len(leading)

        # Separa chiave: valore rispettando eventuali ':' dentro stringhe quotate
        in_quote: Optional[str] = None
        colon_idx = -1
        for idx, ch in enumerate(stripped):
            if ch in ('"', "'"):
                if in_quote is None:
                    in_quote = ch
                elif in_quote == ch:
                    in_quote = None
            elif ch == ":" and in_quote is None:
                if idx + 1 == len(stripped) or stripped[idx + 1].isspace():
                    colon_idx = idx
                    break
        if colon_idx < 0:
            return None, [f"{md_path.name}:{line_no}: riga YAML non valida '{stripped}'."]

        key, _ = _unquote_yaml_token(stripped[:colon_idx])
        if not key:
            return None, [f"{md_path.name}:{line_no}: chiave YAML vuota."]
        raw_val = stripped[colon_idx + 1 :].strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if key in parent:
            return None, [f"{md_path.name}:{line_no}: chiave YAML duplicata '{key}'."]

        if raw_val == "" or raw_val.startswith("#"):
            child: Dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
        else:
            parent[key] = _parse_yaml_scalar(raw_val)

    return root, []


def validate_kilo_agents(agents_dir: Path) -> Tuple[bool, List[str]]:
    """Valida lo schema di tutti gli agenti markdown in .kilo/agents/."""
    if not agents_dir.is_dir():
        return False, [f"Directory agenti {agents_dir} mancante."]

    md_files = sorted(agents_dir.glob("*.md"))
    if not md_files:
        return False, [f"Nessun file agente .md trovato in {agents_dir}."]

    issues: List[str] = []
    for md_path in md_files:
        fm, parse_issues = _parse_agent_frontmatter(md_path)
        if parse_issues:
            issues.extend(parse_issues)
            continue
        assert fm is not None
        issues.extend(_validate_agent_dict(fm, md_path.name, require_fields=True))

    return (len(issues) == 0), issues


def validate_kilo_config(config_path: Path) -> Tuple[bool, List[str]]:
    """Verifica schema Kilo e vincoli di sicurezza offline su kilo.json e .kilo/agents."""
    issues = []
    if not config_path.is_file():
        return False, [f"File {config_path} mancante."]

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        return False, [f"Errore parsing JSON: {exc}"]

    if not isinstance(data, dict):
        return False, ["Schema kilo.json non valido: atteso oggetto JSON root."]

    # 0. Controllo schema chiavi top-level e $schema
    for bad_key, expected_key in FORBIDDEN_PLURAL_KEYS.items():
        if bad_key in data:
            issues.append(
                f"Chiave schema non valida '{bad_key}' in kilo.json: usare '{expected_key}'."
            )

    if "$schema" in data:
        schema_val = data["$schema"]
        if not isinstance(schema_val, str) or not schema_val.startswith("https://"):
            issues.append(f"Campo '$schema' non valido in kilo.json: {schema_val!r}")

    if "plugin" in data:
        plugins = data["plugin"]
        if not isinstance(plugins, list) or not all(isinstance(p, str) and p.strip() for p in plugins):
            issues.append("Campo 'plugin' in kilo.json deve essere una lista di stringhe non vuote.")

    # 1. Verifica provider
    providers = data.get("provider")
    if not isinstance(providers, dict) or not providers:
        issues.append("Nessun provider configurato (atteso oggetto non vuoto).")
    else:
        for pname, pcfg in providers.items():
            if not isinstance(pcfg, dict):
                issues.append(f"Provider {pname} deve essere un oggetto JSON.")
                continue
            opts = pcfg.get("options")
            base_url = opts.get("baseURL", "") if isinstance(opts, dict) else ""
            if not isinstance(opts, dict):
                issues.append(f"Provider {pname} richiede oggetto 'options'.")
            if not isinstance(base_url, str) or not (
                base_url.startswith("http://127.0.0.1") or base_url.startswith("http://localhost")
            ):
                issues.append(f"Provider {pname} baseURL non punta a loopback: {base_url}")
            npm_pkg = pcfg.get("npm", "")
            if npm_pkg != "@ai-sdk/openai-compatible":
                issues.append(f"Provider {pname} utilizza pacchetto non locale/OpenAI-compatible: {npm_pkg}")
            if "models" in pcfg:
                models = pcfg["models"]
                if not isinstance(models, dict):
                    issues.append(f"Provider {pname}.models deve essere un oggetto JSON.")
                else:
                    for mid, mcfg in models.items():
                        if not isinstance(mcfg, dict):
                            issues.append(f"Provider {pname}.models.{mid} deve essere un oggetto JSON.")
                            continue
                        if "limit" in mcfg:
                            lim = mcfg["limit"]
                            if (
                                not isinstance(lim, dict)
                                or not _is_positive_int(lim.get("context"))
                                or not _is_positive_int(lim.get("output"))
                            ):
                                issues.append(
                                    f"Provider {pname}.models.{mid}.limit richiede 'context' e 'output' interi positivi."
                                )

    # 2. Verifica modelli primari
    model = data.get("model", "")
    if not isinstance(model, str) or not model.startswith("hexagon/"):
        issues.append(f"model non punta al provider locale hexagon: {model}")

    small_model = data.get("small_model", "")
    if not isinstance(small_model, str) or not small_model.startswith("hexagon/"):
        issues.append(f"small_model non punta al provider locale hexagon: {small_model}")

    # 3. Verifica permessi (schema PermissionConfig + sicurezza)
    if "permission" in data:
        issues.extend(_validate_permission_config(data["permission"], "kilo.json", require_safe_defaults=True))

    # 4. Verifica eventuali agenti inline in kilo.json
    if "agent" in data:
        agents_cfg = data["agent"]
        if not isinstance(agents_cfg, dict):
            issues.append("Campo 'agent' in kilo.json deve essere un oggetto JSON.")
        else:
            for agent_name, agent_val in agents_cfg.items():
                issues.extend(
                    _validate_agent_dict(agent_val, f"kilo.json:agent.{agent_name}", require_fields=False)
                )

    # 5. Verifica agenti markdown in .kilo/agents se presenti nel workspace
    agents_dir = config_path.parent / ".kilo" / "agents"
    if agents_dir.is_dir():
        _, agent_issues = validate_kilo_agents(agents_dir)
        issues.extend(agent_issues)

    return (len(issues) == 0), issues


def main():
    parser = argparse.ArgumentParser(description="Gestore configurazione Kilo per Hexagon")
    parser.add_argument("--generate", action="store_true", help="Genera kilo.json nel workspace")
    parser.add_argument("--check", action="store_true", help="Valida kilo.json esistente")
    parser.add_argument("--status", action="store_true", help="Mostra stato configurazione e modelli")
    parser.add_argument("--install-global", action="store_true",
                        help="Installa/aggiorna il provider hexagon nel config globale di Kilo (~/.config/kilo)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Porta HTTP del router (default: 18803)")
    args = parser.parse_args()

    base_url = f"http://127.0.0.1:{args.port}/v1"
    config_file = DEFAULT_WORKSPACE / "kilo.json"

    if args.install_global:
        path, changed, issues = install_global_provider(DEFAULT_WORKSPACE)
        if issues:
            print("Errori installazione provider globale:")
            for issue in issues:
                print(f" - {issue}")
            sys.exit(1)
        print(f"Provider hexagon {'installato/aggiornato' if changed else 'gia allineato'} in {path}")
        if changed:
            print("Backup del file precedente creato con timestamp nello stesso percorso.")
        sys.exit(0)

    if args.check:
        ok, issues = validate_kilo_config(config_file)
        if ok:
            print("Configurazione kilo.json VALIDA e conforme alle regole di sicurezza offline.")
            sys.exit(0)
        else:
            print("Errori rilevati in kilo.json:")
            for issue in issues:
                print(f" - {issue}")
            sys.exit(1)

    if args.generate or not config_file.is_file():
        cfg = generate_kilo_config(DEFAULT_WORKSPACE, base_url=base_url)
        path = write_kilo_config(DEFAULT_WORKSPACE, cfg)
        print(f"Generato {path} con successo ({len(cfg['provider']['hexagon']['models'])} modelli).")

    if args.status:
        ok, issues = validate_kilo_config(config_file)
        live = fetch_live_models(base_url)
        print(f"Stato kilo.json: {'Valido' if ok else 'Problemi rilevati'}")
        print(f"Router live su {base_url}: {'Online (' + str(len(live)) + ' modelli)' if live else 'Offline'}")
        if config_file.is_file():
            with open(config_file, "r", encoding="utf-8") as f:
                d = json.load(f)
            print(f"Modello principale: {d.get('model')}")
            print(f"Small model:        {d.get('small_model')}")


if __name__ == "__main__":
    main()
