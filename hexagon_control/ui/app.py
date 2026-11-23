import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from rich.panel import Panel
from rich.text import Text

from .components import Interface
from .screens import Screens

AREA_HINTS = {
    "1": "Router: A avvia │ P anteprima │ S stop │ R riavvia │ L log │ X stop gestiti │ B indietro",
    "2": "Direct: M scegli modello │ P anteprima │ A avvia │ S stop │ B indietro",
    "3": "Verifica prerequisiti in sola lettura │ Invio per continuare",
    "4": "Kilo Code: modello, ruolo e cartella progetto │ B annulla",
    "5": "Diagnostica: R refresh │ P porta │ B benchmark │ L log │ E errori │ Q indietro",
    "6": "Modelli: D dettagli │ T test tool calling │ I integrità/hash │ R refresh │ B indietro",
    "7": "Preset INI: V visualizza │ C controlla │ E modifica │ P anteprima │ G rigenera │ B indietro",
    "8": "Percorsi/link: A/R directory │ H/Y link │ D rimuovi │ I integrità │ B indietro",
    "9": "Update: R refresh │ C check online │ S sincronizza │ G aggiorna GenieX │ B indietro",
    "c": "Chat: digita il messaggio o un comando slash (/help) │ Ctrl+C interrompe │ Ctrl+D esce",
    "l": "Live dashboard │ Invio per tornare al menu",
}

MENU_CLICKABLES = [
    ("1 Router", "1"),
    ("2 Singolo modello", "2"),
    ("3 Verifica", "3"),
    ("4 Kilo Code", "4"),
    ("5 Diagnostica", "5"),
    ("6 Modelli", "6"),
    ("7 Preset INI", "7"),
    ("8 Link", "8"),
    ("9 Aggiornamenti", "9"),
    ("C Chat", "c"),
    ("L Live dashboard", "l"),
    ("? Guida", "?"),
    ("Q Esci", "q"),
]

# Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}.
MENU_SLASH = {
    "/router": ("1", "Gestione router multi-modello"),
    "/direct": ("2", "Avvio diretto singolo modello"),
    "/verifica": ("3", "Prerequisiti e sicurezza"),
    "/kilo": ("4", "Kilo Code su cartella progetto"),
    "/diagnostica": ("5", "Diagnostica e monitoraggio"),
    "/modelli": ("6", "Inventario GGUF"),
    "/preset": ("7", "Editor preset INI"),
    "/link": ("8", "Percorsi e link modelli"),
    "/update": ("9", "Aggiornamenti stack"),
    "/chat": ("c", "Chat locale"),
    "/live": ("l", "Dashboard live"),
    "/guida": ("?", "Guida tasti e comandi"),
    "/esci": ("q", "Esci dal control center"),
}

AREA_SLASH = {
    "1": {
        "/avvia": ("a", "Avvia il router"), "/anteprima": ("p", "Anteprima preset"),
        "/stop": ("s", "Arresta il server della sessione"),
        "/riavvia": ("r", "Riavvia il router"), "/log": ("l", "Log router"),
        "/stop-gestiti": ("x", "Stop tutti i server gestiti"),
        "/indietro": ("b", "Torna al menu"),
    },
    "2": {
        "/scegli": ("m", "Scegli modello"), "/anteprima": ("p", "Anteprima comando"),
        "/avvia": ("a", "Avvia il modello"), "/stop": ("s", "Arresta il server"),
        "/ricarica": ("r", "Ricarica inventario"), "/indietro": ("b", "Torna al menu"),
    },
    "5": {
        "/refresh": ("r", "Aggiorna metriche"), "/porta": ("p", "Cambia porta"),
        "/benchmark": ("b", "Benchmark modello"), "/log": ("l", "Log recenti"),
        "/errori": ("e", "Solo errori"), "/indietro": ("q", "Torna al menu"),
    },
    "6": {
        "/dettagli": ("d", "Metadati modello"), "/test": ("t", "Test tool calling"),
        "/integrita": ("i", "Header e SHA-256"), "/refresh": ("r", "Ricarica inventario"),
        "/indietro": ("b", "Torna al menu"),
    },
    "7": {
        "/visualizza": ("v", "Mostra INI"), "/controlla": ("c", "Valida sintassi"),
        "/modifica": ("e", "Modifica parametro"), "/anteprima": ("p", "Anteprima diff"),
        "/rigenera": ("g", "Rigenera preset"), "/indietro": ("b", "Torna al menu"),
    },
    "8": {
        "/aggiungi": ("a", "Aggiungi directory"), "/rimuovi": ("r", "Rimuovi directory"),
        "/hardlink": ("h", "Crea hard-link"), "/symlink": ("y", "Crea symlink"),
        "/rimuovi-link": ("d", "Rimuovi link"), "/integrita": ("i", "Verifica GGUF"),
        "/indietro": ("b", "Torna al menu"),
    },
    "9": {
        "/refresh": ("r", "Refresh locale"), "/check": ("c", "Check release online"),
        "/sync": ("s", "Sincronizza runtime"), "/geniex": ("g", "Aggiorna GenieX"),
        "/indietro": ("b", "Torna al menu"),
    },
    "l": {"/indietro": ("", "Torna al menu (Invio)")},
}


class ControlCenter:
    def __init__(self, processes, catalog, presets, links, diagnostics, kilo, updates, settings):
        self.ui = Interface()
        self.processes = processes
        self.settings = settings
        self.screens = Screens(self.ui, processes, catalog, presets, links, diagnostics, kilo, updates, settings)
        self.actions = {
            "1": self.screens.router,
            "2": self.screens.direct,
            "3": self.screens.prerequisites,
            "4": self.screens.kilo,
            "5": self.screens.diagnostics,
            "6": self.screens.inventory,
            "7": self.screens.presets,
            "8": self.screens.paths_and_links,
            "9": self.screens.updates,
            "c": self.screens.chat,
            "l": self.live_dashboard,
        }
        self.ui.set_status_provider(self._top_status)
        self.ui.set_help_callback(self.help)

    def _top_status(self) -> str:
        online, latency, models = self.processes.health_snapshot()
        router = "ONLINE" if online else "OFFLINE"
        detail = f"{latency:.0f} ms │ {len(models)} modelli" if online else ""
        parts = [f"│ {self.processes.base_url}", f"│ Router {router}"]
        if detail:
            parts.append(f"│ {detail}")
        return " ".join(parts)

    def dashboard_renderable(self):
        online, latency, models = self.processes.health_snapshot()
        owned = ", ".join(f"{record.mode}:{port}" for port, record in self.processes.owned.items()) or "nessuno"
        managed = self.processes.processes_snapshot(managed_only=True)
        process_status = ", ".join(f"PID {p['pid']} ({p['memory_mb']} MB)" for p in managed) or "nessuno"
        content = Text("HEXAGON CONTROL CENTER\n", style="bold cyan")
        content.append("Windows 11 ARM64 | Snapdragon X2 Elite Extreme\n", style="dim")
        content.append(f"Endpoint: {self.processes.base_url}\n")
        content.append("Router: ", style="bold")
        content.append("ONLINE" if online else "OFFLINE", style="green" if online else "red")
        if online:
            content.append(f" | {latency:.1f} ms | {len(models)} modelli registrati")
        content.append("\nSlot caricati: N/D (non esposti in modo affidabile dall'endpoint)\n", style="dim")
        content.append(f"Processi avviati da questa sessione: {owned}\n")
        content.append(f"Server gestiti: {process_status}\n")
        content.append(
            "1 Router   2 Singolo modello   3 Verifica   4 Kilo Code   5 Diagnostica\n"
            "6 Modelli  7 Preset INI        8 Link       9 Aggiornamenti\n"
            "C Chat     L Live dashboard    ? Guida      Q Esci",
            style="bold",
        )
        return Panel(content, border_style="cyan", padding=(1, 2))

    def live_dashboard(self):
        self.ui.set_hint(AREA_HINTS["l"])
        stop = threading.Event()

        def refresh():
            while not stop.is_set():
                try:
                    self.ui.replace_body(self.dashboard_renderable())
                except Exception as exc:
                    # Mai silenziato: l'errore resta visibile nella barra di stato.
                    self.ui.report_error(f"Dashboard: {exc}")
                stop.wait(2)

        worker = threading.Thread(target=refresh, daemon=True)
        worker.start()
        try:
            self.ui.prompt("Live dashboard attiva (refresh 2s)", "")
        finally:
            stop.set()
            worker.join(timeout=3)

    def help(self):
        self.ui.table("Navigazione", ("Tasto", "Funzione"), [
            ("1…9", "Nove aree operative (tasto singolo, frecce+Invio o click)"),
            ("Frecce / Invio", "Seleziona una voce del menu e attivala"),
            ("Tab oppure /", "Modalità input: digitazione libera senza tasti singoli"),
            ("/", "Comandi slash contestuali alla schermata, con completamento"),
            ("C", "Chat OpenAI-compatibile locale"),
            ("L", "Dashboard aggiornata ogni 2 secondi"),
            ("B", "Indietro nei sottomenu"),
            ("R", "Aggiorna la schermata corrente"),
            ("Q", "Uscita e scelta del ciclo di vita dei server"),
            ("Esc", "Annulla il prompt corrente (o esce dalla modalità input)"),
            ("F1 / F10", "Guida / Uscita (globali)"),
            ("Ctrl+F", "Ricerca incrementale nel corpo; Invio prossimo, Esc fine"),
            ("PgUp/PgDn/Home/End", "Scorre il corpo; rotella mouse e scrollbar"),
            ("Mouse", "Click sulle voci evidenziate; hover per il suggerimento"),
        ])

    def _dispatch(self, choice: str) -> bool:
        """Esegue la scelta del menu; False per uscire."""
        if choice in ("q", "quit", "exit"):
            return False
        if choice in ("?", "help"):
            self.help()
            return True
        action = self.actions.get(choice)
        if action is None:
            if choice:
                self.ui.console.print("Scelta non valida. ? mostra la guida.")
            return True
        self.ui.set_hint(AREA_HINTS.get(choice, ""))
        self.ui.set_slash_commands(AREA_SLASH.get(choice, {}))
        try:
            action()
        except KeyboardInterrupt:
            self.ui.console.print("\nOperazione corrente interrotta. Q per uscire.")
        except Exception as exc:
            self.ui.error(exc)
        finally:
            self.ui.set_hint("")
            self.ui.set_slash_commands(MENU_SLASH)
            self.ui.set_clickables(MENU_CLICKABLES)
        return True

    def run(self):
        if self.settings.load_error:
            self.ui.console.print(f"Configurazione non leggibile; uso valori predefiniti: {self.settings.load_error}")
        self.ui.set_clickables(MENU_CLICKABLES)
        self.ui.set_slash_commands(MENU_SLASH)
        self.processes.start_status_cache()
        # Il loop dell'app gira sul thread chiamante (di norma il main); il menu
        # e le schermate vivono in un executor e comunicano con eventi/code.
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="hexagon-actions") as executor:
            menu = executor.submit(self._menu_loop)
            try:
                self.ui.start()
            finally:
                if not menu.done():
                    # L'app e' terminata da sola (es. EOF): sveglia il menu.
                    self.ui.stop()
                menu.result()
        self.processes.stop_status_cache()
        self.exit_lifecycle()

    def _menu_loop(self):
        """Ciclo del menu sul thread delle azioni; termina con ui.stop()."""
        if not self.ui.wait_ready(10):
            return
        quit_requested = False
        while self.ui.running:
            self.ui.replace_body(self.dashboard_renderable())
            try:
                choice = self.ui.prompt(single_key=True)
            except KeyboardInterrupt:
                self.ui.console.print("\nOperazione interrotta. Q per uscire.")
                continue
            if not self._dispatch(choice):
                quit_requested = True
                break
        if quit_requested:
            # Conferma di uscita con l'app ancora attiva: la full-screen resta usabile.
            self.exit_lifecycle()
        elif self.processes.owned:
            print("Sessione UI terminata; server ancora attivi: "
                  + ", ".join(map(str, self.processes.owned)))
        self.ui.stop()

    def exit_lifecycle(self):
        if not self.processes.owned:
            return
        self.ui.console.print("Server avviati da questa sessione: " + ", ".join(map(str, self.processes.owned)))
        try:
            keep = not self.ui.confirm("Arrestare questi server prima di uscire?")
        except KeyboardInterrupt:
            # Esc annulla la conferma: scelta sicura, i server restano attivi.
            keep = True
        result = self.processes.shutdown(keep_running=keep)
        self.ui.result(result)
