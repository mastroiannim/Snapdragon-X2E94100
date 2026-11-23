import shutil
import subprocess
from pathlib import Path
from typing import Optional

import kilo_config

from .results import OperationResult


class KiloController:
    roles = ("interattivo", "code", "plan", "debug", "explore", "reviewer")

    def __init__(self, workspace_dir: Path, processes, settings):
        self.workspace_dir = Path(workspace_dir)
        self.processes = processes
        self.settings = settings

    def prepare(self, main_model: str, small_model: str) -> OperationResult:
        online, _, models = self.processes.health()
        if not online:
            started = self.processes.start("Router")
            if not started.ok:
                return OperationResult(False, "Router non disponibile: " + started.message)
            online, _, models = self.processes.health()
        if not online:
            return OperationResult(False, "Health check router fallito")
        main = main_model.removeprefix("hexagon/")
        small = small_model.removeprefix("hexagon/")
        if models and main not in models:
            return OperationResult(False, f"Modello principale non registrato: {main}")
        if models and small not in models:
            return OperationResult(False, f"Modello ausiliario non registrato: {small}")
        try:
            config = kilo_config.generate_kilo_config(
                self.workspace_dir, self.processes.base_url,
                preferred_model=main, preferred_small_model=small,
            )
            path = kilo_config.write_kilo_config(self.workspace_dir, config)
            valid, issues = kilo_config.validate_kilo_config(path)
        except (OSError, ValueError, TypeError) as exc:
            return OperationResult(False, f"Configurazione Kilo fallita: {exc}")
        if not valid:
            return OperationResult(False, "Configurazione non sicura: " + "; ".join(issues))
        return OperationResult(True, f"Configurazione valida: {path}")

    def launch(self, main_model: str, small_model: str, role: str = "interattivo",
               pure: bool = False, workdir: Optional[str] = None) -> OperationResult:
        if role not in self.roles:
            return OperationResult(False, "Ruolo Kilo non valido")
        target = self.workspace_dir
        if workdir:
            candidate = Path(workdir).expanduser()
            if not candidate.is_dir():
                return OperationResult(False, f"Cartella di lavoro non trovata: {candidate}")
            target = candidate.resolve()
        prepared = self.prepare(main_model, small_model)
        if not prepared.ok:
            return prepared
        workspace_resolved = self.workspace_dir.resolve()
        if target != workspace_resolved and workspace_resolved not in target.parents:
            path, changed, issues = kilo_config.install_global_provider(self.workspace_dir)
            if issues:
                return OperationResult(False, "Provider globale non installabile: " + "; ".join(issues))
            if changed:
                prepared = OperationResult(
                    True, prepared.message + f"; provider hexagon aggiornato in {path}")
        executable = shutil.which("kilo.cmd") or shutil.which("kilo")
        if not executable:
            return OperationResult(False, "kilo.cmd non trovato nel PATH")
        arguments = [executable, str(target), "-m", "hexagon/" + main_model.removeprefix("hexagon/")]
        if role != "interattivo":
            arguments += ["--agent", role]
        if pure:
            arguments += ["--pure"]
        try:
            completed = subprocess.run(arguments, cwd=target)
        except OSError as exc:
            return OperationResult(False, f"Avvio Kilo fallito: {exc}")
        return OperationResult(completed.returncode == 0,
                               f"Kilo terminato con codice {completed.returncode} in {target}")
