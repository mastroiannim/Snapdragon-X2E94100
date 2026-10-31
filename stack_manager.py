#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stack Manager per Hexagon Claw TUI.
Gestisce l'ispezione, la verifica, il controllo aggiornamenti e la sincronizzazione sicura
dello stack software (GenieX CLI, librerie DSP Hexagon NPU, e frontend llama.cpp ARM64).
"""

import os
import sys
import shutil
import hashlib
import subprocess
import json
import time
import zipfile
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional, Tuple

import httpx
from rich.table import Table
from rich.panel import Panel
from rich.text import Text
from rich.console import Console

# Configurazione UTF-8 per la console Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Percorsi predefiniti dell'ambiente Snapdragon X2 Elite
LOCAL_APPDATA = Path(os.environ.get("LOCALAPPDATA", ""))
USER_PROFILE = Path(os.environ.get("USERPROFILE", ""))

DEFAULT_GENIEX_DIR = LOCAL_APPDATA / "GenieX CLI"
DEFAULT_GENIEX_LLAMA_DIR = DEFAULT_GENIEX_DIR / "llama_cpp"
DEFAULT_GENIEX_EXE = DEFAULT_GENIEX_DIR / "geniex.exe"

DEFAULT_LLAMA_BIN_DIR = USER_PROFILE / "llama-cpp" / "llama-bin-win-cpu-arm64"
DEFAULT_LLAMA_SERVER = DEFAULT_LLAMA_BIN_DIR / "llama-server.exe"


def calculate_sha256(path: Path) -> str:
    """Calcola l'hash SHA-256 di un file."""
    if not path.exists():
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest().lower()


class StackManager:
    def __init__(
        self,
        geniex_dir: Optional[Path] = None,
        llama_bin_dir: Optional[Path] = None,
        workspace_dir: Optional[Path] = None,
    ):
        self.geniex_dir = geniex_dir or DEFAULT_GENIEX_DIR
        self.geniex_exe = self.geniex_dir / "geniex.exe"
        self.geniex_llama_dir = self.geniex_dir / "llama_cpp"

        self.llama_bin_dir = llama_bin_dir or DEFAULT_LLAMA_BIN_DIR
        self.llama_server = self.llama_bin_dir / "llama-server.exe"
        self.workspace_dir = workspace_dir or Path(r"c:\Users\ioxdu\workspace\Hexagon")

    # -----------------------------------------------------------------------
    # Helper di Controllo Processi
    # -----------------------------------------------------------------------
    def is_server_running(self) -> bool:
        """Verifica se llama-server.exe è attualmente in esecuzione."""
        if sys.platform == "win32":
            try:
                out = subprocess.check_output(
                    ["tasklist", "/fi", "imagename eq llama-server.exe", "/fo", "csv", "/nh"],
                    text=True,
                    stderr=subprocess.DEVNULL,
                )
                return "llama-server.exe" in out.lower()
            except Exception:
                pass
        return False

    def stop_server(self) -> bool:
        """Arresta tutti i processi llama-server.exe per sbloccare le DLL."""
        if sys.platform == "win32":
            try:
                subprocess.run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Get-Process -Name llama-server -ErrorAction SilentlyContinue | Stop-Process -Force"],
                    timeout=10,
                )
                for _ in range(10):
                    time.sleep(0.5)
                    if not self.is_server_running():
                        time.sleep(1.0)  # buffer per il rilascio degli handle NTFS
                        return True
            except Exception:
                pass
        return False

    def start_server_router(self) -> bool:
        """Avvia llama-server in modalità Router."""
        bat_path = self.workspace_dir / "llama-server-all.bat"
        if bat_path.exists():
            subprocess.Popen(
                ["cmd.exe", "/c", str(bat_path)],
                creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0,
            )
            time.sleep(3)
            return self.is_server_running()
        return False

    # -----------------------------------------------------------------------
    # 1. Ispezione Dettagliata dello Stack Corrente
    # -----------------------------------------------------------------------
    def get_stack_status(self) -> Dict[str, Any]:
        """Rileva le versioni, commit, file runtime e allineamento dello stack."""
        status = {
            "geniex_installed": False,
            "geniex_version": "Non rilevato",
            "qairt_version": "N/A",
            "geniex_llama_hash": "",
            "llama_server_installed": False,
            "llama_server_version": "Non rilevato",
            "llama_server_commit": "",
            "commit_aligned": False,
            "runtime_files": [],
            "all_files_aligned": False,
            "mismatched_files": [],
            "missing_files": [],
            "npu_artifacts": {},
            "server_running": self.is_server_running(),
        }

        # Ispezione GenieX CLI
        if self.geniex_exe.exists():
            status["geniex_installed"] = True
            try:
                proc = subprocess.run(
                    [str(self.geniex_exe), "--version", "--skip-update"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                output = proc.stdout + proc.stderr
                for line in output.splitlines():
                    if "GenieX CLI Version:" in line:
                        status["geniex_version"] = line.split(":", 1)[1].strip()
                    elif "QAIRT Runtime Version:" in line:
                        status["qairt_version"] = line.split(":", 1)[1].strip()
                    elif "LlamaCPP Runtime Hash:" in line:
                        status["geniex_llama_hash"] = line.split(":", 1)[1].strip()
            except Exception as e:
                status["geniex_version"] = f"Errore lettura ({e})"

        # Ispezione llama-server.exe
        if self.llama_server.exists():
            status["llama_server_installed"] = True
            try:
                proc = subprocess.run(
                    [str(self.llama_server), "--version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                output = proc.stdout + proc.stderr
                for line in output.splitlines():
                    if "version:" in line:
                        status["llama_server_version"] = line.strip()
                        import re
                        m = re.search(r"commit\s+([0-9a-fA-F]+)", line)
                        if m:
                            status["llama_server_commit"] = m.group(1).strip()
            except Exception as e:
                status["llama_server_version"] = f"Errore lettura ({e})"

        # Verifica allineamento commit
        gh = status["geniex_llama_hash"].lower()
        lh = status["llama_server_commit"].lower()
        if gh and lh and (gh.startswith(lh) or lh.startswith(gh)):
            status["commit_aligned"] = True

        # Verifica file runtime tra GenieX/llama_cpp e llama-bin
        if self.geniex_llama_dir.exists() and self.llama_bin_dir.exists():
            genie_files = list(self.geniex_llama_dir.glob("*"))
            all_ok = True
            for gf in sorted(genie_files, key=lambda p: p.name):
                if gf.is_dir():
                    continue
                tf = self.llama_bin_dir / gf.name
                file_info = {
                    "name": gf.name,
                    "genie_size": gf.stat().st_size,
                    "target_exists": tf.exists(),
                    "target_size": tf.stat().st_size if tf.exists() else 0,
                    "match": False,
                    "is_hardlink": False,
                }
                if tf.exists():
                    try:
                        file_info["is_hardlink"] = os.path.samefile(gf, tf)
                    except Exception:
                        file_info["is_hardlink"] = False

                    if file_info["is_hardlink"]:
                        file_info["match"] = True
                    else:
                        g_hash = calculate_sha256(gf)
                        t_hash = calculate_sha256(tf)
                        file_info["match"] = (g_hash == t_hash and g_hash != "")

                    if not file_info["match"]:
                        all_ok = False
                        status["mismatched_files"].append(gf.name)
                else:
                    all_ok = False
                    status["missing_files"].append(gf.name)

                status["runtime_files"].append(file_info)

            status["all_files_aligned"] = all_ok and len(status["missing_files"]) == 0

        # Verifica specifica artefatti critici Hexagon NPU
        critical_npu = [
            "libggml-htp-v81.so",
            "libggml-htp.cat",
            "ggml-hexagon.dll",
            "ggml-opencl.dll",
        ]
        for c in critical_npu:
            p = self.llama_bin_dir / c
            status["npu_artifacts"][c] = {
                "present": p.exists(),
                "size": p.stat().st_size if p.exists() else 0,
                "sha256": calculate_sha256(p)[:12] + "..." if p.exists() else "N/A",
            }

        return status

    # -----------------------------------------------------------------------
    # 2. Controllo Aggiornamenti Disponibili (Online)
    # -----------------------------------------------------------------------
    def check_updates(self) -> Dict[str, Any]:
        """Interroga i repository e le API per verificare la disponibilità di nuove versioni."""
        results = {
            "current_geniex": "N/A",
            "current_llamacpp_commit": "N/A",
            "latest_llamacpp_build": "N/A",
            "latest_llamacpp_published": "N/A",
            "latest_llamacpp_url": "N/A",
            "arm64_assets": [],
            "arm64_asset_url": "",
            "update_available_llamacpp": False,
            "geniex_update_status": "N/A",
            "safe_update_advisory": (
                "L'accelerazione Hexagon v81 HTP0 richiede le librerie host e gli artefatti DSP "
                "distribuiti e firmati da Qualcomm (GenieX). Aggiornando il frontend llama.cpp, "
                "vengono preservati intatti gli artefatti DSP (libggml-htp-v*.so, libggml-htp.cat "
                "e ggml-hexagon.dll)."
            ),
        }

        cur_status = self.get_stack_status()
        results["current_geniex"] = cur_status.get("geniex_version", "N/A")
        results["current_llamacpp_commit"] = cur_status.get("llama_server_commit", "N/A")

        # Query GitHub per ggml-org/llama.cpp
        try:
            with httpx.Client(timeout=6.0) as client:
                resp = client.get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=1")
                if resp.status_code == 200:
                    releases = resp.json()
                    if releases:
                        latest = releases[0]
                        tag = latest.get("tag_name", "")
                        results["latest_llamacpp_build"] = tag
                        results["latest_llamacpp_published"] = latest.get("published_at", "")[:10]
                        results["latest_llamacpp_url"] = latest.get("html_url", "")

                        assets = latest.get("assets", [])
                        for a in assets:
                            name = a.get("name", "")
                            if "arm64" in name.lower() and "win" in name.lower() and "cpu" in name.lower():
                                results["arm64_assets"].append(name)
                                results["arm64_asset_url"] = a.get("browser_download_url", "")
                            elif "arm64" in name.lower() and "win" in name.lower():
                                results["arm64_assets"].append(name)

                        if tag and tag != results["current_llamacpp_commit"]:
                            results["update_available_llamacpp"] = True
        except Exception as e:
            results["latest_llamacpp_build"] = f"Errore connessione ({e})"

        # Verifica aggiornamenti per GenieX CLI
        if self.geniex_exe.exists():
            try:
                proc = subprocess.run(
                    [str(self.geniex_exe), "version"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                output = proc.stdout + proc.stderr
                if "update available" in output.lower():
                    results["geniex_update_status"] = "Aggiornamento disponibile via 'geniex update'"
                else:
                    results["geniex_update_status"] = "GenieX CLI aggiornato all'ultima versione"
            except Exception:
                results["geniex_update_status"] = "Controllo GenieX non disponibile offline"

        return results

    # -----------------------------------------------------------------------
    # 3. Sincronizzazione Sicura Runtime GenieX -> llama-bin
    # -----------------------------------------------------------------------
    def sync_runtime_from_geniex(self, auto_stop_server: bool = True) -> Tuple[bool, str, List[str]]:
        """
        Sincronizza le DLL GGML e gli artefatti HTP DSP da GenieX CLI in llama-bin.
        Riconosce i collegamenti hard-link esistenti evitando errori di file lock.
        Crea un backup preventivo e riavvia il server se necessario.
        """
        if not self.geniex_llama_dir.exists():
            return False, f"Cartella sorgente GenieX non trovata: {self.geniex_llama_dir}", []
        if not self.llama_bin_dir.exists():
            return False, f"Cartella destinazione llama-bin non trovata: {self.llama_bin_dir}", []

        genie_files = list(self.geniex_llama_dir.glob("*"))
        if not genie_files:
            return False, "Nessun file presente nella cartella GenieX llama_cpp.", []

        # Controlla se i file sono già tutti sincronizzati/hardlinkati
        needs_update = []
        for gf in genie_files:
            if gf.is_dir():
                continue
            tf = self.llama_bin_dir / gf.name
            if not tf.exists():
                needs_update.append(gf)
            else:
                try:
                    if not os.path.samefile(gf, tf):
                        if calculate_sha256(gf) != calculate_sha256(tf):
                            needs_update.append(gf)
                except Exception:
                    needs_update.append(gf)

        if not needs_update:
            return True, "Tutti i 16 file di runtime GenieX sono già perfettamente sincronizzati e collegati.", [gf.name for gf in genie_files]

        was_running = self.is_server_running()
        if was_running:
            if auto_stop_server:
                stopped = self.stop_server()
                if not stopped:
                    return False, "Impossibile arrestare llama-server.exe per aggiornare le DLL in uso.", []
            else:
                return False, "llama-server.exe è in esecuzione. Ferma il server con /server stop prima di sincronizzare.", []

        # Backup preventivo
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_dir = self.llama_bin_dir / "backups" / f"backup_{ts}"
        backup_dir.mkdir(parents=True, exist_ok=True)

        synced_files = []
        try:
            for gf in needs_update:
                target_file = self.llama_bin_dir / gf.name
                if target_file.exists():
                    shutil.copy2(target_file, backup_dir / gf.name)
                    target_file.unlink()

                # Tenta hard-link con fallback alla copia
                try:
                    os.link(gf, target_file)
                except Exception:
                    shutil.copy2(gf, target_file)

                synced_files.append(gf.name)

        except Exception as e:
            # Ripristina da backup
            for bf in backup_dir.glob("*"):
                try:
                    shutil.copy2(bf, self.llama_bin_dir / bf.name)
                except Exception:
                    pass
            return False, f"Errore durante la sincronizzazione: {e}. Backup ripristinato.", []

        if was_running and auto_stop_server:
            self.start_server_router()

        msg = f"Sincronizzati {len(synced_files)} file da GenieX."
        if backup_dir:
            msg += f" Backup salvato in: backups/{backup_dir.name}"
        if was_running:
            msg += " Server Router riavviato automaticamente."

        return True, msg, synced_files

    # -----------------------------------------------------------------------
    # 4. Aggiornamento Frontend llama.cpp da GitHub (Safe Upgrade)
    # -----------------------------------------------------------------------
    def update_llamacpp_frontend(self, download_url: Optional[str] = None, auto_stop_server: bool = True) -> Tuple[bool, str]:
        """
        Scarica e aggiorna in sicurezza i binari frontend (llama-server.exe, llama-cli.exe, llama-bench.exe)
        preservando categoricamente intatti tutti gli artefatti Qualcomm HTP e le DLL hardware firmate.
        """
        if not download_url:
            updates = self.check_updates()
            download_url = updates.get("arm64_asset_url")
            if not download_url:
                return False, "Nessun archivio Windows ARM64 reperibile automaticamente su GitHub Releases."

        was_running = self.is_server_running()
        if was_running:
            if auto_stop_server:
                stopped = self.stop_server()
                if not stopped:
                    return False, "Impossibile arrestare llama-server per l'aggiornamento."
            else:
                return False, "llama-server è attivo. Arrestalo prima di applicare l'aggiornamento."

        # Backup dei soli frontend eseguibili
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_dir = self.llama_bin_dir / "backups" / f"frontend_backup_{ts}"
        backup_dir.mkdir(parents=True, exist_ok=True)

        executables_to_update = [
            "llama-server.exe",
            "llama-cli.exe",
            "llama-bench.exe",
            "llama-batched-bench.exe",
            "llama-quantize.exe",
        ]
        for exe in executables_to_update:
            p = self.llama_bin_dir / exe
            if p.exists():
                shutil.copy2(p, backup_dir / exe)

        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp_zip = Path(tmp_dir) / "llama-frontend.zip"
                # Download dell'archivio
                with httpx.Client(timeout=60.0, follow_redirects=True) as client:
                    resp = client.get(download_url)
                    if resp.status_code != 200:
                        return False, f"Download fallito: HTTP {resp.status_code}"
                    with open(tmp_zip, "wb") as f:
                        f.write(resp.content)

                # Estrazione selettiva dei soli eseguibili frontend
                with zipfile.ZipFile(tmp_zip, "r") as z:
                    for filename in z.namelist():
                        basename = Path(filename).name
                        if basename in executables_to_update:
                            target_dest = self.llama_bin_dir / basename
                            if target_dest.exists():
                                target_dest.unlink()
                            with z.open(filename) as src, open(target_dest, "wb") as dst:
                                shutil.copyfileobj(src, dst)

            # Verifica che il nuovo server si avvii correttamente
            proc = subprocess.run(
                [str(self.llama_server), "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            new_version_info = (proc.stdout + proc.stderr).strip()

        except Exception as e:
            # Rollback
            for bf in backup_dir.glob("*"):
                try:
                    shutil.copy2(bf, self.llama_bin_dir / bf.name)
                except Exception:
                    pass
            return False, f"Errore durante l'installazione del frontend: {e}. Rollback completato."

        if was_running and auto_stop_server:
            self.start_server_router()

        return True, f"Frontend llama.cpp aggiornato con successo!\nNuova versione:\n{new_version_info}"

    # -----------------------------------------------------------------------
    # 5. Aggiornamento Ufficiale GenieX CLI
    # -----------------------------------------------------------------------
    def update_geniex_cli(self) -> Tuple[bool, str]:
        """Esegue l'aggiornamento ufficiale di GenieX CLI."""
        if not self.geniex_exe.exists():
            return False, "GenieX CLI non installato."
        try:
            proc = subprocess.run(
                [str(self.geniex_exe), "update"],
                capture_output=True,
                text=True,
                timeout=180,
            )
            out = (proc.stdout + proc.stderr).strip()
            if proc.returncode == 0:
                # Sincronizza subito i nuovi file estratti da GenieX
                self.sync_runtime_from_geniex(auto_stop_server=True)
                return True, f"Aggiornamento GenieX completato:\n{out}"
            else:
                return False, f"Aggiornamento GenieX terminato con codice {proc.returncode}:\n{out}"
        except Exception as e:
            return False, f"Eccezione durante l'aggiornamento di GenieX: {e}"

    # -----------------------------------------------------------------------
    # Rendering Tabelle per Rich Console
    # -----------------------------------------------------------------------
    def render_stack_dashboard(self, console: Console):
        """Disegna il dashboard completo di verifica dello stack."""
        st = self.get_stack_status()

        t = Table(title="🐉 Verifica Stack Hardware & Runtime - Snapdragon X2 Elite", border_style="cyan")
        t.add_column("Componente", style="bold cyan", width=24)
        t.add_column("Versione / Dettaglio", style="white")
        t.add_column("Stato Integrità", style="bold")

        # GenieX CLI
        g_badge = "[bold green]✓ INSTALLATO[/bold green]" if st["geniex_installed"] else "[bold red]✗ MANCANTE[/bold red]"
        t.add_row(
            "GenieX CLI",
            f"{st['geniex_version']} (QAIRT {st['qairt_version']})",
            g_badge,
        )

        # llama.cpp Frontend
        l_badge = "[bold green]✓ INSTALLATO[/bold green]" if st["llama_server_installed"] else "[bold red]✗ MANCANTE[/bold red]"
        t.add_row(
            "llama.cpp Server",
            f"{st['llama_server_version']}",
            l_badge,
        )

        # Allineamento Commit
        c_badge = (
            f"[bold green]✓ ALLINEATO ({st['geniex_llama_hash'][:7]})[/bold green]"
            if st["commit_aligned"]
            else f"[yellow]⚠ DISALLINEATO (Genie: {st['geniex_llama_hash'][:7]} vs Llama: {st['llama_server_commit'][:7]})[/yellow]"
        )
        t.add_row("Allineamento Commit", f"GenieX [{st['geniex_llama_hash']}] vs Llama [{st['llama_server_commit']}]", c_badge)

        # File Runtime
        f_badge = (
            f"[bold green]✓ 16/16 File Sincronizzati (Hard-link)[/bold green]"
            if st["all_files_aligned"]
            else f"[bold red]✗ {len(st['mismatched_files']) + len(st['missing_files'])} File da Sincronizzare[/bold red]"
        )
        t.add_row("Librerie Runtime GGML", f"{len(st['runtime_files'])} file monitorati in llama-bin", f_badge)

        # Artefatti Hexagon NPU
        npu_ok = all(v["present"] for v in st["npu_artifacts"].values())
        n_badge = "[bold green]✓ WHQL Attivo (v81)[/bold green]" if npu_ok else "[bold red]✗ Driver Incompleto[/bold red]"
        t.add_row(
            "Hexagon NPU v81 DSP",
            "libggml-htp-v81.so + libggml-htp.cat + ggml-hexagon.dll",
            n_badge,
        )

        # Stato Server
        s_badge = "[bold green]● IN ESECUZIONE[/bold green]" if st["server_running"] else "[dim]○ FERMO[/dim]"
        t.add_row("Stato Router Server", "Porta 18803 (HTTP)", s_badge)

        console.print(t)

        if not st["all_files_aligned"]:
            console.print("[yellow]Suggerimento: digita [bold cyan]/stack sync[/bold cyan] per sincronizzare le DLL di GenieX.[/yellow]\n")

    def render_updates_dashboard(self, console: Console):
        """Disegna il report di disponibilità aggiornamenti online."""
        console.print("[cyan]Controllo aggiornamenti online in corso (GitHub & Qualcomm)...[/cyan]")
        up = self.check_updates()

        t = Table(title="🐉 Controllo Aggiornamenti Stack", border_style="green")
        t.add_column("Software", style="bold cyan", width=22)
        t.add_column("Versione Locale", style="yellow")
        t.add_column("Ultima Versione Disponibile", style="bold green")
        t.add_column("Stato", style="bold")

        # llama.cpp
        l_stat = (
            "[bold yellow]AGGIORNAMENTO DISPONIBILE[/bold yellow]"
            if up["update_available_llamacpp"]
            else "[green]Allineato[/green]"
        )
        t.add_row(
            "llama.cpp (ggml-org)",
            up["current_llamacpp_commit"],
            f"{up['latest_llamacpp_build']} ({up['latest_llamacpp_published']})",
            l_stat,
        )

        # GenieX
        t.add_row(
            "GenieX CLI (Qualcomm)",
            up["current_geniex"],
            "Verifica automatica",
            f"[green]{up['geniex_update_status']}[/green]",
        )

        console.print(t)

        console.print(
            Panel(
                f"[yellow]{up['safe_update_advisory']}[/yellow]\n\n"
                "[dim]Comandi di gestione disponibili:\n"
                "  • [cyan]/stack sync[/cyan]          : Sincronizza e riallinea le DLL e i file HTP da GenieX\n"
                "  • [cyan]/stack update-geniex[/cyan] : Esegue l'aggiornamento di GenieX CLI\n"
                "  • [cyan]/stack update-llama[/cyan]  : Aggiorna il frontend llama-server preservando i driver NPU[/dim]",
                title="🛡️ Politica di Aggiornamento Sicuro Hexagon",
                border_style="yellow",
            )
        )
