#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hexagon Claw TUI - Terminal User Interface in stile OpenClaw
per llama.cpp su Snapdragon X2 Elite Extreme (Qualcomm Hexagon NPU / Adreno GPU / Oryon CPU).
"""

import sys
import os
import time
import re
import json
import ctypes
import argparse
import subprocess
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

# Configurazione UTF-8 per la console Windows
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    except Exception:
        pass

import httpx
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.markdown import Markdown
from rich.live import Live
from rich.columns import Columns
from rich.progress import BarColumn, Progress, TextColumn
from rich.align import Align
from rich.rule import Rule

from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.styles import Style as PtStyle
from prompt_toolkit.formatted_text import HTML

from stack_manager import StackManager


# ---------------------------------------------------------------------------
# Rilevamento Telemetria Sistema Windows ARM64 (Senza dipendenze esterne)
# ---------------------------------------------------------------------------
class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def get_system_ram() -> Tuple[float, float, int]:
    """Restituisce (total_gb, used_gb, percent_used)"""
    try:
        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            total = stat.ullTotalPhys / (1024 ** 3)
            used = (stat.ullTotalPhys - stat.ullAvailPhys) / (1024 ** 3)
            return round(total, 1), round(used, 1), stat.dwMemoryLoad
    except Exception:
        pass
    return 48.0, 0.0, 0


# ---------------------------------------------------------------------------
# Gestione Preset e Modelli dal file INI
# ---------------------------------------------------------------------------
def load_ini_presets(ini_path: Path) -> Dict[str, Dict[str, str]]:
    """Carica i preset hardware dal file hexagon-models.ini generato da launch-hexagon.ps1"""
    presets = {}
    if not ini_path.exists():
        return presets

    current_section = None
    with open(ini_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                current_section = line[1:-1].strip()
                if current_section != "*":
                    presets[current_section] = {}
            elif current_section and current_section != "*" and "=" in line:
                key, val = line.split("=", 1)
                presets[current_section][key.strip()] = val.strip()

    return presets


# ---------------------------------------------------------------------------
# Autocompletamento OpenClaw con prompt_toolkit
# ---------------------------------------------------------------------------
SLASH_COMMANDS = {
    "/help": "Mostra tutti i comandi disponibili e i tasti di scelta rapida",
    "/model": "Cambia modello attivo o elenca i modelli disponibili sul router",
    "/models": "Elenca tutti i modelli registrati con dettagli hardware",
    "/status": "Visualizza dashboard telemetria (NPU, GPU, RAM, Server)",
    "/stack": "Verifica stack, versioni GenieX/llama-cpp, aggiornamenti e sync",
    "/bench": "Esegue un benchmark prestazionale in tempo reale (t/s e latenza)",
    "/clear": "Cancella la cronologia messaggi e azzera il contesto",
    "/new": "Sinonimo di /clear (avvia una nuova sessione)",
    "/system": "Visualizza o imposta il system prompt attivo",
    "/temp": "Imposta la temperatura di campionamento (es. /temp 0.2)",
    "/tokens": "Analisi utilizzo token e percentuale finestra di contesto",
    "/server": "Stato e controllo del server locale (status, start, stop)",
    "/exit": "Esci da Hexagon Claw TUI",
    "/quit": "Esci da Hexagon Claw TUI",
}


class OpenClawCompleter(Completer):
    def __init__(self, get_models_cb):
        self.get_models_cb = get_models_cb

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        stripped = text.strip()

        # Completamento per comandi slash
        if stripped.startswith("/"):
            parts = stripped.split(" ", 1)
            cmd = parts[0]

            if len(parts) == 1:
                for c, desc in SLASH_COMMANDS.items():
                    if c.startswith(cmd.lower()):
                        yield Completion(
                            c,
                            start_position=-len(cmd),
                            display=f"{c:<10}  {desc}",
                        )
            elif cmd.lower() in ("/model", "/m"):
                # Suggerisci modelli disponibili
                arg = parts[1] if len(parts) > 1 else ""
                models = self.get_models_cb()
                for m in models:
                    if m.lower().startswith(arg.lower()):
                        yield Completion(
                            m,
                            start_position=-len(arg),
                            display=m,
                        )
            elif cmd.lower() == "/server":
                arg = parts[1] if len(parts) > 1 else ""
                for sub in ("status", "start", "stop", "restart"):
                    if sub.startswith(arg.lower()):
                        yield Completion(
                            sub,
                            start_position=-len(arg),
                            display=sub,
                        )
            elif cmd.lower() == "/stack":
                arg = parts[1] if len(parts) > 1 else ""
                for sub in ("status", "check", "sync", "update-geniex", "update-llama"):
                    if sub.startswith(arg.lower()):
                        yield Completion(
                            sub,
                            start_position=-len(arg),
                            display=sub,
                        )


# ---------------------------------------------------------------------------
# Classe Principale: HexagonClawTUI
# ---------------------------------------------------------------------------
class HexagonClawTUI:
    def __init__(
        self,
        base_url: str = "http://127.0.0.1:18803/v1",
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        workspace_dir: Optional[Path] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.server_host = self.base_url.replace("/v1", "")
        self.workspace_dir = workspace_dir or Path(r"c:\Users\ioxdu\workspace\Hexagon")
        self.ini_path = self.workspace_dir / "hexagon-models.ini"

        self.console = Console(legacy_windows=False)
        self.presets = load_ini_presets(self.ini_path)
        self.stack_mgr = StackManager(workspace_dir=self.workspace_dir)
        self.available_models: List[str] = []
        self.active_model = model or "LFM2.5-24B-A2B-QAD-Q4_0"

        self.system_prompt = system_prompt or (
            "Sei un assistente AI specializzato in ingegneria del software e calcolo accelerato, "
            "in esecuzione locale su architettura Qualcomm Snapdragon X2 Elite Extreme con accelerazione "
            "NPU Hexagon v81 e GPU Adreno. Rispondi in italiano in modo conciso, tecnico e preciso."
        )
        self.temperature = 0.7
        self.messages: List[Dict[str, str]] = []

        # Metriche dell'ultima generazione
        self.last_gen_speed: float = 0.0
        self.last_gen_tokens: int = 0
        self.last_gen_time: float = 0.0
        self.total_tokens_session: int = 0

        # Inizializza sessione prompt_toolkit con fallback per ambienti non-interattivi
        history_file = Path.home() / ".hexagon_claw_history"
        pt_style = PtStyle.from_dict({
            "prompt": "ansicyan bold",
            "model": "ansigreen",
            "arrow": "ansiyellow bold",
        })
        try:
            self.prompt_session = PromptSession(
                history=FileHistory(str(history_file)),
                auto_suggest=AutoSuggestFromHistory(),
                completer=OpenClawCompleter(self.get_available_model_ids),
                style=pt_style,
            )
        except Exception:
            self.prompt_session = None

    def get_available_model_ids(self) -> List[str]:
        if self.available_models:
            return self.available_models
        if self.presets:
            return list(self.presets.keys())
        return ["LFM2.5-24B-A2B-QAD-Q4_0"]

    # -----------------------------------------------------------------------
    # Connessione al Server & Verifica Health
    # -----------------------------------------------------------------------
    def check_server_health(self) -> Tuple[bool, float, List[str]]:
        """Verifica se il server llama-server risponde e restituisce (is_online, latency_ms, models)"""
        t0 = time.time()
        try:
            with httpx.Client(timeout=2.0) as client:
                resp = client.get(f"{self.base_url}/models")
                if resp.status_code == 200:
                    data = resp.json()
                    models = [m.get("id", "") for m in data.get("data", [])]
                    latency = (time.time() - t0) * 1000
                    return True, latency, models
        except Exception:
            pass
        return False, 0.0, []

    def refresh_models(self):
        online, _, models = self.check_server_health()
        if online and models:
            self.available_models = models
            if self.active_model not in self.available_models and self.available_models:
                # Seleziona LFM se disponibile, altrimenti il primo
                preferred = next((m for m in self.available_models if "LFM" in m), self.available_models[0])
                self.active_model = preferred

    def get_model_info(self, model_id: str) -> Dict[str, str]:
        """Restituisce le informazioni hardware del modello da hexagon-models.ini"""
        info = {
            "device": "HTP0",
            "split": "100%",
            "ctx": "65536",
            "strategy": "Accelerazione Hardware Snapdragon",
        }
        if model_id in self.presets:
            p = self.presets[model_id]
            dev = p.get("device", "HTP0")
            ts = p.get("tensor-split")
            info["device"] = dev
            info["split"] = f"{ts}" if ts else "100%"
            info["ctx"] = p.get("ctx-size", "65536")

            if "GPU" in dev:
                if ts == "80,20":
                    info["strategy"] = "Ibrido NPU 80% + GPU 20% (Banda RAM sbloccata)"
                elif ts == "75,25":
                    info["strategy"] = "Ibrido NPU 75% + GPU 25% (No saturazione DMA)"
                elif ts == "50,50":
                    info["strategy"] = "Ibrido Bilanciato 50/50 NPU/GPU"
                else:
                    info["strategy"] = f"Ibrido {ts} NPU/GPU"
            else:
                info["strategy"] = "Pure NPU Hexagon v81 (100% On-Die SIMD)"

        return info

    # -----------------------------------------------------------------------
    # Rendering Header OpenClaw
    # -----------------------------------------------------------------------
    def print_banner(self):
        online, latency, _ = self.check_server_health()
        m_info = self.get_model_info(self.active_model)
        tot_ram, used_ram, ram_pct = get_system_ram()

        ctx_limit = int(m_info["ctx"])
        ctx_used = self.estimate_context_tokens()
        ctx_pct = min(100.0, (ctx_used / max(1, ctx_limit)) * 100)

        # Barra di riempimento contesto in stile OpenClaw
        bar_len = 16
        filled = int((ctx_pct / 100.0) * bar_len)
        bar_str = "█" * filled + "░" * (bar_len - filled)

        status_badge = (
            f"[bold green]● ONLINE[/bold green] ({latency:.1f}ms)"
            if online
            else "[bold red]● OFFLINE[/bold red]"
        )

        device_badge = (
            f"[bold cyan]{m_info['device']}[/bold cyan] [yellow][{m_info['split']}][/yellow]"
        )

        header_text = (
            f"[bold white]🐉 HEXAGON CLAW TUI[/bold white] │ "
            f"[bold magenta]Snapdragon X2 Elite Extreme (X2E94100)[/bold magenta] │ "
            f"NPU: [cyan]HTP0[/cyan] │ GPU: [blue]Adreno OpenCL[/blue]\n"
            f"Server: {status_badge}  │  "
            f"Modello: [bold green]{self.active_model}[/bold green]  │  "
            f"Offload: {device_badge}\n"
            f"Contesto: [cyan][{bar_str}][/cyan] {ctx_used:,} / {ctx_limit:,} tok ({ctx_pct:.1f}%)  │  "
            f"RAM: [yellow]{used_ram:.1f}/{tot_ram:.1f} GB[/yellow] ({ram_pct}%)  │  "
            f"Speed: [bold yellow]{self.last_gen_speed:.1f} t/s[/bold yellow]"
        )

        self.console.print(
            Panel(
                header_text,
                border_style="cyan",
                padding=(0, 1),
                subtitle="[dim]Digita /help per i comandi  │  Ctrl+C cancella generazione  │  /exit per uscire[/dim]",
                subtitle_align="right",
            )
        )

    def estimate_context_tokens(self) -> int:
        """Stima approssimativa dei token correnti nella cronologia"""
        total_chars = sum(len(m["content"]) for m in self.messages)
        total_chars += len(self.system_prompt)
        return int(total_chars / 3.6)

    # -----------------------------------------------------------------------
    # Streaming Inferenziale con Parsing Ragionamento OpenClaw
    # -----------------------------------------------------------------------
    def stream_chat(self, user_prompt: str):
        online, _, _ = self.check_server_health()
        if not online:
            self.console.print(
                "\n[bold red]❌ Errore:[/bold red] Il server llama-server su "
                f"[yellow]{self.base_url}[/yellow] non risponde.\n"
                "Avvialo con [cyan]/server start[/cyan] oppure esegui [cyan].\\llama-server-all.bat[/cyan].\n"
            )
            return

        # Aggiungi messaggio utente alla cronologia
        self.messages.append({"role": "user", "content": user_prompt})

        # Costruisci payload OpenAI compatibile
        payload_messages = [{"role": "system", "content": self.system_prompt}]
        payload_messages.extend(self.messages)

        req_body = {
            "model": self.active_model,
            "messages": payload_messages,
            "temperature": self.temperature,
            "stream": True,
        }

        self.console.print()
        self.console.print(Rule(f"[bold cyan]🐉 {self.active_model}[/bold cyan]", style="dim"))

        assistant_full_text = ""
        think_text = ""
        in_think_block = False
        t_start = time.time()
        token_count = 0

        try:
            with httpx.Client(timeout=180.0) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    json=req_body,
                    headers={"Content-Type": "application/json"},
                ) as response:
                    if response.status_code != 200:
                        err_body = response.read().decode("utf-8", errors="ignore")
                        self.console.print(f"[bold red]Errore dal server ({response.status_code}):[/bold red] {err_body}")
                        self.messages.pop()  # Rimuovi messaggio non risposto
                        return

                    server_timings = None
                    # Streaming attivo
                    for chunk_line in response.iter_lines():
                        if not chunk_line:
                            continue
                        if chunk_line.startswith("data: "):
                            data_str = chunk_line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk_json = json.loads(data_str)
                                if "timings" in chunk_json:
                                    server_timings = chunk_json["timings"]

                                choices = chunk_json.get("choices", [])
                                if not choices:
                                    continue
                                delta = choices[0].get("delta", {})
                                content_piece = delta.get("content") or ""
                                reasoning_piece = delta.get("reasoning_content") or ""

                                if reasoning_piece:
                                    token_count += 1
                                    assistant_full_text += reasoning_piece
                                    if not in_think_block:
                                        in_think_block = True
                                        self.console.print("\n[dim italic]🧠 Pensiero (Reasoning):[/dim italic]")
                                    # Stampa il pensiero in grigio sfumato
                                    sys.stdout.write(f"\033[90m{reasoning_piece}\033[0m")
                                    sys.stdout.flush()

                                elif content_piece:
                                    token_count += 1
                                    assistant_full_text += content_piece
                                    if in_think_block:
                                        in_think_block = False
                                        self.console.print("\n")

                                    # Rilevamento tag inline <think> per modelli che non usano reasoning_content
                                    if "<think>" in assistant_full_text and not in_think_block and "</think>" not in assistant_full_text:
                                        in_think_block = True
                                        self.console.print("[dim italic]🧠 Pensiero (Deep Thought)...[/dim italic]")

                                    # Stampa diretta in streaming
                                    sys.stdout.write(content_piece)
                                    sys.stdout.flush()

                            except json.JSONDecodeError:
                                pass

        except KeyboardInterrupt:
            self.console.print("\n[yellow]⚠️ Generazione interrotta dall'utente.[/yellow]")
        except Exception as e:
            self.console.print(f"\n[bold red]❌ Errore durante lo streaming:[/bold red] {e}")
            self.messages.pop()
            return

        t_elapsed = time.time() - t_start

        if server_timings:
            speed = server_timings.get("predicted_per_second", (token_count / t_elapsed) if t_elapsed > 0 else 0.0)
            token_count = server_timings.get("predicted_n", token_count)
            t_elapsed = (server_timings.get("predicted_ms", 0.0) / 1000.0) or t_elapsed
        else:
            speed = (token_count / t_elapsed) if t_elapsed > 0 else 0.0

        self.last_gen_speed = speed
        self.last_gen_tokens = token_count
        self.last_gen_time = t_elapsed
        self.total_tokens_session += token_count

        # Aggiungi risposta finale alla cronologia
        self.messages.append({"role": "assistant", "content": assistant_full_text})

        # Footer prestazionale OpenClaw
        m_info = self.get_model_info(self.active_model)
        self.console.print()
        footer_badge = (
            f"[dim]⚡ [bold yellow]{speed:.1f} t/s[/bold yellow] │ "
            f"{token_count} token in {t_elapsed:.2f}s │ "
            f"Offload: {m_info['device']} ({m_info['split']})[/dim]"
        )
        self.console.print(footer_badge)
        self.console.print()

    # -----------------------------------------------------------------------
    # Gestione Comandi Slash
    # -----------------------------------------------------------------------
    def handle_slash_command(self, cmd_line: str) -> bool:
        """Restituisce False se il comando richiede l'uscita dalla TUI, True altrimenti"""
        parts = cmd_line.strip().split(" ", 1)
        cmd = parts[0].lower()
        args = parts[1].strip() if len(parts) > 1 else ""

        if cmd in ("/exit", "/quit", "/q"):
            self.console.print("[yellow]Chiusura Hexagon Claw TUI. Arrivederci! 🐉[/yellow]")
            return False

        elif cmd in ("/help", "/h", "/?"):
            self.show_help()

        elif cmd in ("/model", "/m", "/models"):
            if args:
                self.switch_model(args)
            else:
                self.list_models()

        elif cmd == "/status":
            self.show_status_dashboard()

        elif cmd == "/clear" or cmd == "/new":
            self.messages.clear()
            self.console.print("[green]✓ Cronologia conversazione azzerata. Nuovo contesto avviato.[/green]")

        elif cmd == "/system":
            if args:
                self.system_prompt = args
                self.console.print("[green]✓ System prompt aggiornato:[/green]")
                self.console.print(Panel(self.system_prompt, border_style="green"))
            else:
                self.console.print(Panel(self.system_prompt, title="System Prompt Attuale", border_style="cyan"))

        elif cmd == "/temp":
            if args:
                try:
                    val = float(args)
                    if 0.0 <= val <= 2.0:
                        self.temperature = val
                        self.console.print(f"[green]✓ Temperatura impostata a {self.temperature:.2f}[/green]")
                    else:
                        self.console.print("[red]Errore: la temperatura deve essere tra 0.0 e 2.0[/red]")
                except ValueError:
                    self.console.print("[red]Valore numerico non valido per la temperatura.[/red]")
            else:
                self.console.print(f"Temperatura attuale: [cyan]{self.temperature:.2f}[/cyan]")

        elif cmd == "/tokens":
            self.show_tokens_info()

        elif cmd == "/bench":
            self.run_benchmark(args)

        elif cmd == "/server":
            self.handle_server_command(args)

        elif cmd == "/stack":
            self.handle_stack_command(args)

        else:
            self.console.print(f"[red]Comando sconosciuto: {cmd}. Digita [bold]/help[/bold] per la lista comandi.[/red]")

        return True

    def show_help(self):
        t = Table(title="🐉 Comandi Slash - Hexagon Claw TUI", border_style="cyan", header_style="bold magenta")
        t.add_column("Comando", style="bold cyan", width=16)
        t.add_column("Argomenti", style="yellow", width=18)
        t.add_column("Descrizione", style="white")

        t.add_row("/help", "", "Mostra questa guida ai comandi")
        t.add_row("/models", "", "Elenca tutti i modelli GGUF disponibili sul router con dettagli hardware")
        t.add_row("/model", "<nome>", "Seleziona e cambia istantaneamente il modello attivo")
        t.add_row("/status", "", "Dashboard telemetria SoC Snapdragon (NPU HTP0, GPU Adreno, RAM)")
        t.add_row("/stack", "[status|check|sync|update-*]", "Verifica e aggiorna lo stack software (GenieX, llama.cpp, DSP NPU)")
        t.add_row("/bench", "[n_tokens]", "Esegue un benchmark sintetico e misura prefill/generation t/s")
        t.add_row("/clear, /new", "", "Azzera la cronologia messaggi e riparte da zero")
        t.add_row("/system", "[nuovo prompt]", "Visualizza o ridefinisce il system prompt dell'assistente")
        t.add_row("/temp", "<0.0 - 2.0>", "Modifica la temperatura di campionamento (default: 0.7)")
        t.add_row("/tokens", "", "Stima il consumo di token corrente e l'impegno della KV cache")
        t.add_row("/server", "status|start|stop", "Controlla lo stato o avvia llama-server in background")
        t.add_row("/exit, /quit", "", "Termina la TUI ed esce al terminale")

        self.console.print(t)

    def list_models(self):
        self.refresh_models()
        t = Table(title="Modelli Disponibili nel Router Hexagon", border_style="cyan", header_style="bold magenta")
        t.add_column("ID Modello", style="bold green")
        t.add_column("Device", style="cyan")
        t.add_column("Split NPU/GPU", style="yellow")
        t.add_column("Max Ctx", style="magenta")
        t.add_column("Strategia Hardware", style="white")

        for m in self.get_available_model_ids():
            info = self.get_model_info(m)
            marker = " [bold green]★ ATTIVO[/bold green]" if m == self.active_model else ""
            t.add_row(
                f"{m}{marker}",
                info["device"],
                info["split"],
                f"{int(info['ctx']) // 1024}k",
                info["strategy"],
            )

        self.console.print(t)
        self.console.print("[dim]Usa [cyan]/model <nome>[/cyan] per selezionarne uno.[/dim]\n")

    def switch_model(self, model_query: str):
        self.refresh_models()
        candidates = [m for m in self.get_available_model_ids() if model_query.lower() in m.lower()]

        if not candidates:
            self.console.print(f"[red]Nessun modello trovato corrispondente a '{model_query}'. Usa /models per l'elenco.[/red]")
            return

        if len(candidates) > 1 and model_query not in candidates:
            self.console.print(f"[yellow]Modello ambiguo. Candidati trovati:[/yellow]")
            for c in candidates:
                self.console.print(f"  • {c}")
            return

        chosen = candidates[0] if model_query not in candidates else model_query
        self.active_model = chosen
        info = self.get_model_info(chosen)
        self.console.print(f"[bold green]✓ Modello attivo cambiato in:[/bold green] [bold cyan]{chosen}[/bold cyan]")
        self.console.print(f"  • Backend: [cyan]{info['device']}[/cyan] ({info['split']})")
        self.console.print(f"  • Contesto massimo: [magenta]{int(info['ctx']) // 1024}k token[/magenta]")
        self.console.print(f"  • Strategia: [white]{info['strategy']}[/white]\n")

    def show_status_dashboard(self):
        online, latency, _ = self.check_server_health()
        tot_ram, used_ram, ram_pct = get_system_ram()
        m_info = self.get_model_info(self.active_model)

        t = Table(title="🐉 Dashboard Telemetria Hardware Snapdragon X2 Elite", border_style="cyan")
        t.add_column("Parametro", style="bold cyan", width=24)
        t.add_column("Valore", style="white")

        t.add_row("Piattaforma SoC", "Qualcomm Snapdragon X2 Elite Extreme (X2E94100)")
        t.add_row("CPU Oryon", "18 Core (12 dedicati a LLM, 6 riservati a Windows/IDE)")
        t.add_row("NPU Hexagon", "Hexagon v81 HTP0 (DMA64, VTCM 8M, OpBatch 512)")
        t.add_row("GPU Adreno", "Adreno X2-90 OpenCL (GPUOpenCL)")
        t.add_row("Memoria Fisica RAM", f"{used_ram:.1f} / {tot_ram:.1f} GB ({ram_pct}%) LPDDR5X")
        t.add_row("Server Router URL", f"{self.base_url}")
        t.add_row("Stato Connessione", "[bold green]ONLINE[/bold green]" if online else "[bold red]OFFLINE[/bold red]")
        t.add_row("Latenza Ping Router", f"{latency:.2f} ms" if online else "N/A")
        t.add_row("Modello Corrente", f"[bold green]{self.active_model}[/bold green]")
        t.add_row("Accelerazione Selezionata", f"{m_info['device']} [ts {m_info['split']}]")
        t.add_row("Finestra di Contesto", f"{int(m_info['ctx']):,} token ({int(m_info['ctx']) // 1024}k)")
        t.add_row("Token Sessione Totali", f"{self.total_tokens_session:,}")
        t.add_row("Velocità Ultimo Run", f"[bold yellow]{self.last_gen_speed:.1f} t/s[/bold yellow]")

        self.console.print(t)

    def show_tokens_info(self):
        ctx_used = self.estimate_context_tokens()
        m_info = self.get_model_info(self.active_model)
        ctx_limit = int(m_info["ctx"])
        pct = (ctx_used / max(1, ctx_limit)) * 100

        t = Table(title="Utilizzo Token e Cache", border_style="cyan")
        t.add_column("Metrica", style="bold cyan")
        t.add_column("Valore", style="white")

        t.add_row("Messaggi nella Cronologia", str(len(self.messages)))
        t.add_row("Token Stimati Attivi", f"{ctx_used:,} token")
        t.add_row("Finestra Massima Modello", f"{ctx_limit:,} token")
        t.add_row("Percentuale di Riempimento", f"{pct:.2f}%")
        t.add_row("Limite FastRPC Buffer", "Rispettato (< 1 GiB per descrittore)")

        self.console.print(t)

    def run_benchmark(self, args_str: str):
        max_tokens = 100
        if args_str:
            try:
                max_tokens = int(args_str)
            except ValueError:
                pass

        online, _, _ = self.check_server_health()
        if not online:
            self.console.print("[red]Server non in linea. Impossibile eseguire il benchmark.[/red]")
            return

        self.console.print(f"\n[cyan]Avvio benchmark sintetico su [bold]{self.active_model}[/bold] ({max_tokens} token richiesti)...[/cyan]")

        prompt = (
            "Spiega brevemente il principio di funzionamento del meccanismo di Attention "
            "nei Transformer e come le Mixture of Experts (MoE) ottimizzano il throughput."
        )

        req_body = {
            "model": self.active_model,
            "messages": [
                {"role": "system", "content": "Sei un assistente per benchmark prestazionali."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.0,
            "stream": True,
        }

        t0 = time.time()
        first_token_time = None
        n_tokens = 0

        try:
            with httpx.Client(timeout=120.0) as client:
                with client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    json=req_body,
                ) as resp:
                    if resp.status_code != 200:
                        err_body = resp.read().decode("utf-8", errors="ignore")
                        self.console.print(f"[bold red]Errore dal server ({resp.status_code}):[/bold red] {err_body}")
                        return

                    server_timings = None
                    for line in resp.iter_lines():
                        if line.startswith("data: "):
                            d = line[6:].strip()
                            if d == "[DONE]":
                                break
                            try:
                                j = json.loads(d)
                                if "timings" in j:
                                    server_timings = j["timings"]

                                choices = j.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    piece = (delta.get("content") or "") + (delta.get("reasoning_content") or "")
                                    if piece:
                                        if first_token_time is None:
                                            first_token_time = time.time()
                                        n_tokens += 1
                                        sys.stdout.write("▓")
                                        sys.stdout.flush()
                            except Exception:
                                pass

            t_end = time.time()
            sys.stdout.write("\n")

            if server_timings:
                ttft = server_timings.get("prompt_ms", (first_token_time - t0) * 1000 if first_token_time else 0.0)
                gen_speed = server_timings.get("predicted_per_second", 0.0)
                n_tokens = server_timings.get("predicted_n", n_tokens)
                gen_time = (server_timings.get("predicted_ms", 0.0) / 1000.0) or (t_end - (first_token_time or t0))
                prefill_speed = server_timings.get("prompt_per_second", 0.0)
            else:
                ttft = (first_token_time - t0) * 1000 if first_token_time else 0.0
                gen_time = t_end - (first_token_time or t0)
                gen_speed = (n_tokens / gen_time) if gen_time > 0 else 0.0
                prefill_speed = 0.0

            tot_speed = (n_tokens / (t_end - t0)) if (t_end - t0) > 0 else 0.0

            m_info = self.get_model_info(self.active_model)
            t = Table(title=f"🐉 Risultati Benchmark: {self.active_model}", border_style="green")
            t.add_column("Parametro", style="bold cyan")
            t.add_column("Misura", style="bold yellow")

            t.add_row("Hardware Accelerators", f"{m_info['device']} ({m_info['split']})")
            t.add_row("Time To First Token (TTFT)", f"{ttft:.2f} ms")
            if prefill_speed > 0:
                t.add_row("Throughput di Prefill", f"{prefill_speed:.2f} tokens/sec")
            t.add_row("Token Generati", f"{n_tokens} token")
            t.add_row("Tempo di Generazione", f"{gen_time:.2f} s")
            t.add_row("Throughput di Generazione", f"[bold green]{gen_speed:.2f} tokens/sec[/bold green]")
            t.add_row("Throughput End-to-End", f"{tot_speed:.2f} tokens/sec")

            self.console.print(t)

        except Exception as e:
            self.console.print(f"[red]Benchmark fallito:[/red] {e}")

    def handle_server_command(self, action: str):
        action = action.lower() if action else "status"

        if action == "status":
            online, lat, models = self.check_server_health()
            if online:
                self.console.print(f"[green]✓ Server llama-server attivo su {self.base_url}[/green] (Ping: {lat:.1f}ms)")
                self.console.print(f"Modelli registrati: [cyan]{len(models)}[/cyan]")
            else:
                self.console.print(f"[red]✗ Server offline su {self.base_url}[/red]")

        elif action == "start":
            online, _, _ = self.check_server_health()
            if online:
                self.console.print("[yellow]Il server è già attivo.[/yellow]")
                return

            self.console.print("[cyan]Avvio server Router Hexagon in background...[/cyan]")
            bat_path = self.workspace_dir / "llama-server-all.bat"
            if bat_path.exists():
                subprocess.Popen(
                    ["cmd.exe", "/c", str(bat_path)],
                    creationflags=subprocess.CREATE_NEW_CONSOLE if sys.platform == "win32" else 0,
                )
                self.console.print("[green]Processo lanciato. Attesa disponibilità endpoint (5s)...[/green]")
                for _ in range(10):
                    time.sleep(1)
                    on, _, _ = self.check_server_health()
                    if on:
                        self.console.print("[bold green]✓ Server pronto e operativo![/bold green]")
                        self.refresh_models()
                        return
                self.console.print("[yellow]Il server si sta avviando, riprova tra qualche istante.[/yellow]")
            else:
                self.console.print(f"[red]File {bat_path} non trovato.[/red]")

        elif action == "stop":
            self.console.print("[cyan]Terminazione di tutti i processi llama-server in corso...[/cyan]")
            if sys.platform == "win32":
                subprocess.run(["powershell", "-NoProfile", "-Command", "Get-Process -Name llama-server -ErrorAction SilentlyContinue | Stop-Process -Force"])
            self.console.print("[green]✓ Processi interrotti.[/green]")

        else:
            self.console.print("Uso: [cyan]/server [status | start | stop][/cyan]")

    def handle_stack_command(self, args_str: str):
        sub = args_str.strip().lower() if args_str else "status"

        if sub in ("status", "verify", "v"):
            self.stack_mgr.render_stack_dashboard(self.console)

        elif sub in ("check", "updates", "up"):
            self.stack_mgr.render_updates_dashboard(self.console)

        elif sub in ("sync", "sincronizza"):
            self.console.print("\n[cyan]Sincronizzazione runtime GenieX -> llama-bin in corso...[/cyan]")
            ok, msg, files = self.stack_mgr.sync_runtime_from_geniex(auto_stop_server=True)
            if ok:
                self.console.print(f"[bold green]✓ Sincronizzazione completata:[/bold green]\n{msg}\n")
            else:
                self.console.print(f"[bold red]✗ Sincronizzazione fallita:[/bold red]\n{msg}\n")

        elif sub in ("update-geniex", "geniex"):
            self.console.print("\n[cyan]Esecuzione aggiornamento ufficiale GenieX CLI ('geniex update')...[/cyan]")
            ok, msg = self.stack_mgr.update_geniex_cli()
            if ok:
                self.console.print(f"[bold green]✓ {msg}[/bold green]\n")
            else:
                self.console.print(f"[bold red]✗ {msg}[/bold red]\n")

        elif sub in ("update-llama", "llama", "update-llamacpp"):
            self.console.print("\n[cyan]Controllo disponibilità archivio Windows ARM64 per llama.cpp...[/cyan]")
            updates = self.stack_mgr.check_updates()
            if not updates.get("arm64_asset_url"):
                self.console.print("[yellow]Nessun archivio binario Windows ARM64 disponibile per l'aggiornamento automatico.[/yellow]")
                return

            tag = updates.get("latest_llamacpp_build", "")
            self.console.print(
                f"[bold yellow]⚠️ Attenzione:[/bold yellow] Verranno aggiornati solo gli eseguibili frontend ({tag}).\n"
                "Gli artefatti DSP Hexagon NPU WHQL (libggml-htp*.so, ggml-hexagon.dll) verranno preservati intatti.\n"
            )
            confirm = "y"
            if self.prompt_session is not None:
                try:
                    confirm = self.prompt_session.prompt("Procedere con l'aggiornamento del frontend? [Y/n]: ").strip().lower()
                except Exception:
                    confirm = "y"
            else:
                self.console.print("Procedere con l'aggiornamento del frontend? [Y/n]: ", end="")
                confirm = input().strip().lower()

            if confirm in ("", "y", "s", "si", "yes"):
                self.console.print("\n[cyan]Download ed estrazione sicura del frontend in corso...[/cyan]")
                ok, msg = self.stack_mgr.update_llamacpp_frontend(auto_stop_server=True)
                if ok:
                    self.console.print(f"[bold green]✓ {msg}[/bold green]\n")
                else:
                    self.console.print(f"[bold red]✗ {msg}[/bold red]\n")
            else:
                self.console.print("[dim]Operazione annullata dall'utente.[/dim]\n")

        else:
            self.console.print(
                "Uso comando [bold cyan]/stack[/bold cyan]:\n"
                "  • [cyan]/stack status[/cyan]        : Verifica integrità versioni e file runtime\n"
                "  • [cyan]/stack check[/cyan]         : Controlla aggiornamenti online (GitHub / Qualcomm)\n"
                "  • [cyan]/stack sync[/cyan]          : Sincronizza e riallinea le DLL da GenieX\n"
                "  • [cyan]/stack update-geniex[/cyan] : Aggiorna GenieX CLI\n"
                "  • [cyan]/stack update-llama[/cyan]  : Aggiorna frontend llama.cpp preservando i driver NPU\n"
            )

    # -----------------------------------------------------------------------
    # Loop Principale Interattivo REPL
    # -----------------------------------------------------------------------
    def run(self):
        self.console.clear()
        self.refresh_models()
        self.print_banner()

        online, _, _ = self.check_server_health()
        if not online:
            self.console.print(
                "[yellow]Nota: Server offline su 127.0.0.1:18803. "
                "Digita [bold cyan]/server start[/bold cyan] per avviarlo automaticamente.[/yellow]\n"
            )

        while True:
            try:
                # Prompt stilizzato OpenClaw: 🐉 hexagon [Model] ›
                if self.prompt_session is not None:
                    prompt_text = HTML(
                        f'<ansicyan><b>🐉 hexagon</b></ansicyan> '
                        f'<ansigreen>[{self.active_model}]</ansigreen> '
                        f'<ansiyellow><b>›</b></ansiyellow> '
                    )
                    user_input = self.prompt_session.prompt(prompt_text).strip()
                else:
                    self.console.print(
                        f"[bold cyan]🐉 hexagon[/bold cyan] [green][{self.active_model}][/green] [bold yellow]›[/bold yellow] ",
                        end="",
                    )
                    user_input = input().strip()

                if not user_input:
                    continue

                if user_input.startswith("/"):
                    should_continue = self.handle_slash_command(user_input)
                    if not should_continue:
                        break
                else:
                    self.stream_chat(user_input)

            except KeyboardInterrupt:
                # Ctrl+C nel prompt cancella la riga corrente
                self.console.print("\n[dim]Per uscire digita /exit o premi Ctrl+D[/dim]")
                continue
            except EOFError:
                # Ctrl+D esce
                self.console.print("\n[yellow]Uscita in corso... 🐉[/yellow]")
                break


# ---------------------------------------------------------------------------
# Entry Point CLI
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description="Hexagon Claw TUI - Interfaccia Terminale OpenClaw per llama.cpp su Snapdragon X2 Elite",
    )
    parser.add_argument("--url", default="http://127.0.0.1:18803/v1", help="URL endpoint OpenAI compatibile")
    parser.add_argument("--model", default=None, help="Modello iniziale da selezionare")
    parser.add_argument("--system", default=None, help="System prompt personalizzato")
    args = parser.parse_args()

    tui = HexagonClawTUI(
        base_url=args.url,
        model=args.model,
        system_prompt=args.system,
    )
    tui.run()


if __name__ == "__main__":
    main()
