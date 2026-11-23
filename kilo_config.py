#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Configuratore e sincronizzatore per Kilo Code su runtime Hexagon GGUF.

Genera e valida kilo.json mappando i preset hardware di hexagon-models.ini
e gli ID restituiti dall'endpoint locale OpenAI-compatibile.
"""

import argparse
import configparser
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

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


def validate_kilo_config(config_path: Path) -> Tuple[bool, List[str]]:
    """Verifica che la configurazione rispetti i vincoli di sicurezza offline."""
    issues = []
    if not config_path.is_file():
        return False, [f"File {config_path} mancante."]

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        return False, [f"Errore parsing JSON: {exc}"]

    # 1. Verifica provider
    providers = data.get("provider", {})
    if not providers:
        issues.append("Nessun provider configurato.")
    for pname, pcfg in providers.items():
        base_url = pcfg.get("options", {}).get("baseURL", "")
        if not (base_url.startswith("http://127.0.0.1") or base_url.startswith("http://localhost")):
            issues.append(f"Provider {pname} baseURL non punta a loopback: {base_url}")
        npm_pkg = pcfg.get("npm", "")
        if npm_pkg != "@ai-sdk/openai-compatible":
            issues.append(f"Provider {pname} utilizza pacchetto non locale/OpenAI-compatible: {npm_pkg}")

    # 2. Verifica modelli primari
    model = data.get("model", "")
    if not model.startswith("hexagon/"):
        issues.append(f"model non punta al provider locale hexagon: {model}")

    small_model = data.get("small_model", "")
    if not small_model.startswith("hexagon/"):
        issues.append(f"small_model non punta al provider locale hexagon: {small_model}")

    # 3. Verifica permessi
    perms = data.get("permission", {})
    if perms.get("edit") == "allow":
        issues.append("Permesso edit globale impostato su allow (deve essere ask per sicurezza).")
    if perms.get("bash") == "allow":
        issues.append("Permesso bash globale impostato su allow (deve essere ask per sicurezza).")

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
