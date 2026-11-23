"""Interfaccia full-screen per il Control Center in stile Kilo Code.

Layout fisso su alternate screen (nessuno scroll del terminale), toolbar superiore
di stato, area contenuto scorrevile col mouse, barra domanda + riga di input,
toolbar inferiore con shortcut e suggerimenti contestuali.

Il codice dei menu (Screens/ControlCenter) resta invariato: la classe espone la
stessa API pubblica della vecchia interfaccia a riga di comando (prompt, confirm,
pause, table, result, error, console) con fallback non interattivo quando la
full-screen app non e' attiva (test, pipe, ambienti headless).
"""

import io
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from prompt_toolkit import Application
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import Completer, Completion
from prompt_toolkit.document import Document
from prompt_toolkit.filters import Condition, has_focus
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import (
    FormattedTextControl,
    HSplit,
    Layout,
    Window,
)
from prompt_toolkit.layout.controls import BufferControl as _BufferControl
from prompt_toolkit.mouse_events import MouseEventType
from prompt_toolkit.widgets import TextArea
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

_INTERRUPT = object()


def _body_width() -> int:
    try:
        return max(100, shutil.get_terminal_size((140, 30)).columns)
    except OSError:
        return 140


class _BodyControl(_BufferControl):
    """BufferControl che risolve i click sulle voci cliccabili registrate."""

    def __init__(self, iface: "Interface", **kwargs):
        super().__init__(**kwargs)
        self._iface = iface

    def mouse_handler(self, mouse_event):
        if mouse_event.event_type == MouseEventType.MOUSE_UP:
            processed = self._last_get_processed_line(mouse_event.position.y)
            if processed is not None:
                line = "".join(fragment for fragment, _ in processed.fragments)
                value = self._iface.click_value_for_line(line)
                if value is not None:
                    self._iface.resolve_prompt(value)
                    return None
        return super().mouse_handler(mouse_event)


class _BodyConsole(Console):
    """Console Rich che renderizza nel corpo della full-screen app come testo."""

    def __init__(self, iface: "Interface"):
        self._sink = io.StringIO()
        super().__init__(
            file=self._sink,
            force_terminal=False,
            color_system=None,
            width=_body_width(),
            legacy_windows=False,
        )
        self._iface = iface

    def print(self, *args, **kwargs):  # noqa: A003 - stessa firma di Console.print
        super().print(*args, **kwargs)
        text = self._sink.getvalue()
        self._sink.seek(0)
        self._sink.truncate(0)
        if text:
            self._iface.append_body(text)

    def clear(self):
        self._iface.clear_body()

    def status(self, status, **kwargs):
        return _StaticStatus(self._iface, status)


class _StaticStatus:
    """Sostituto minimale di rich.status.Status per il rendering nel corpo."""

    def __init__(self, iface: "Interface", status):
        self._iface = iface
        self._label = status.plain if isinstance(status, Text) else str(status)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
        return False

    def start(self):
        self._iface.append_body(f"⏳ {self._label}\n")

    def stop(self):
        pass


class _SlashCompleter(Completer):
    """Completamento per la modalita' slash: comandi contestuali alla schermata."""

    def __init__(self, iface: "Interface"):
        self._iface = iface

    def get_completions(self, document, complete_event):
        text = document.text_before_cursor
        if not text.startswith("/"):
            return
        for command, (_key, description) in self._iface.slash_commands.items():
            if command.startswith(text):
                yield Completion(
                    command,
                    start_position=-len(text),
                    display=f"{command:<18} {description}",
                )


class _PendingPrompt:
    def __init__(self, question: str, default: Optional[str], single_key: bool,
                 quick: Optional[Dict[str, object]] = None):
        self.question = question
        self.default = default
        self.single_key = single_key
        self.quick = quick or {}
        self.event = threading.Event()
        self.result: object = None

    def resolve(self, value: object):
        if self.event.is_set():
            return
        self.result = value
        self.event.set()


class Interface:
    """Interfaccia Control Center con layout fisso, toolbar, shortcut e mouse."""

    def __init__(self, completer: Optional[Completer] = None):
        self.console = _BodyConsole(self)
        self._body_text = ""
        self._body_buffer: Optional[Buffer] = None
        self._clickables: List[Tuple[str, object]] = []
        self._click_lines: Dict[int, object] = {}
        self._hint = ""
        self._question = ""
        self._default: Optional[str] = None
        self._pending: Optional[_PendingPrompt] = None
        # Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}
        self.slash_commands: Dict[str, Tuple[str, str]] = {}
        self._input: Optional[TextArea] = None
        self._app: Optional[Application] = None
        self._loop = None
        self._thread: Optional[threading.Thread] = None
        self._status_provider: Callable[[], str] = lambda: ""
        # Guard di diagnostica: True mentre viene eseguito un callback di layout
        # (toolbar/fragment). I provider devono leggere solo cache: uno I/O
        # bloccante qui congela l'intera UI a ogni redraw.
        self._in_render = False
        self._stop_clock = threading.Event()
        self.history_file = Path.home() / ".hexagon_control_history"

    # ------------------------------------------------------------------
    # Ciclo di vita della full-screen app (thread dedicato)
    # ------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self):
        if self.running:
            return
        self._stop_clock.clear()
        self._thread = threading.Thread(target=self._run_app, name="hexagon-tui", daemon=True)
        self._thread.start()
        deadline = time.monotonic() + 5
        while (self._app is None or self._loop is None) and time.monotonic() < deadline and self.running:
            time.sleep(0.02)

    def stop(self):
        self._stop_clock.set()
        if self._app is not None and self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._app.exit)
            except RuntimeError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        self._loop = None
        self._app = None
        self._reject_pending()

    def suspended(self):
        """Context manager: sospende la full-screen app per subprocess/chat esterne."""
        return _Suspend(self)

    def _run_app(self):
        import asyncio

        # Application.run() creerebbe un loop proprio con asyncio.run();
        # serve invece il nostro loop perche' il thread principale lo usa
        # con call_soon_threadsafe per aggiornare corpo, domande e hint.
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._app = self._build_app()
            self._loop.run_until_complete(self._app.run_async())
        except Exception:
            pass
        finally:
            self._app = None
            self._loop = None

    def _reject_pending(self):
        pending, self._pending = self._pending, None
        if pending is not None:
            pending.resolve(_INTERRUPT)

    def _invalidate(self):
        if self._app is not None and self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._app.invalidate)
            except RuntimeError:
                pass

    # ------------------------------------------------------------------
    # Costruzione layout e key bindings
    # ------------------------------------------------------------------
    def _build_app(self) -> Application:
        self._body_buffer = Buffer(read_only=True)
        if self._body_text:
            self._body_buffer.set_document(
                Document(self._body_text, len(self._body_text)), bypass_readonly=True)

        body_control = _BodyControl(self, buffer=self._body_buffer, focusable=False)
        body = Window(
            body_control,
            wrap_lines=False,
            allow_scroll_beyond_bottom=True,
            always_hide_cursor=True,
        )

        self._input = TextArea(
            multiline=False,
            prompt="",
            history=FileHistory(str(self.history_file)) if self.history_file else None,
            auto_suggest=AutoSuggestFromHistory(),
            completer=_SlashCompleter(self),
            complete_while_typing=True,
            style="class:input",
        )

        input_focused = has_focus(self._input)

        kb = KeyBindings()

        @kb.add("enter", eager=True)
        def _accept(event):
            pending = self._pending
            if pending is None:
                return
            value = self._input.buffer.document.text.strip()
            pending.resolve(value if value or pending.default is None else pending.default)
            self._finish_prompt()

        @kb.add("escape", eager=True)
        def _cancel(event):
            pending = self._pending
            if pending is None:
                return
            pending.resolve(pending.default if pending.default is not None else "")
            self._finish_prompt()

        @kb.add("c-c", eager=True)
        def _interrupt(event):
            if self._pending is not None:
                self._pending.resolve(_INTERRUPT)
                self._finish_prompt()

        @kb.add("c-l", eager=True)
        def _clear(event):
            self.clear_body()

        @kb.add("f1", eager=True)
        def _help(event):
            if self._pending is not None and self._pending.single_key:
                self._pending.resolve("?")
                self._finish_prompt()

        @kb.add("f10", eager=True)
        def _quit(event):
            if self._pending is not None and self._pending.single_key:
                self._pending.resolve("q")
                self._finish_prompt()

        def _quick_key(char: str):
            def _active() -> bool:
                # Filtro preciso: la binding matcha SOLO quando il tasto
                # risolve davvero il prompt; altrimenti il tasto prosegue ai
                # binding di default (inserimento testo).
                pending = self._pending
                if pending is None or self._input is None:
                    return False
                if pending.quick and char in pending.quick:
                    return True
                return pending.single_key and char != "/" and not self._input.buffer.document.text

            @kb.add(char, eager=True, filter=Condition(_active) & input_focused)
            def _quick(event):
                pending = self._pending
                if pending is None:
                    return
                if pending.quick and char in pending.quick:
                    pending.resolve(pending.quick[char])
                else:
                    pending.resolve(char)
                self._finish_prompt()

        for char in "0123456789abcdefghijklmnopqrstuvwxyz?":
            _quick_key(char)

        layout = HSplit(
            [
                Window(
                    FormattedTextControl(self._top_toolbar),
                    height=1,
                    style="class:top-toolbar",
                ),
                body,
                Window(
                    FormattedTextControl(self._question_fragments),
                    height=1,
                    style="class:question-bar",
                ),
                self._input,
                Window(
                    FormattedTextControl(self._bottom_toolbar),
                    height=1,
                    style="class:bottom-toolbar",
                ),
            ]
        )

        app = Application(
            layout=Layout(layout),
            key_bindings=kb,
            full_screen=True,
            mouse_support=True,
            style=self._style(),
        )
        return app

    def _build_completer(self) -> Optional[Completer]:
        return None

    @staticmethod
    def _style():
        from prompt_toolkit.styles import Style

        return Style.from_dict({
            "top-toolbar": "bg:#005f5f #ffffff bold",
            "bottom-toolbar": "bg:#222222 #dddddd",
            "question": "ansicyan bold",
            "idle": "ansibrightblack",
            "question-bar": "",
            "input": "",
        })

    # ------------------------------------------------------------------
    # Toolbar
    # ------------------------------------------------------------------
    def _top_toolbar(self):
        self._in_render = True
        try:
            status = self._status_provider() or "Hexagon Control Center"
        finally:
            self._in_render = False
        clock = datetime.now().strftime("%H:%M")
        return f" 🐉 HEXAGON {status} │ {clock} "

    def _question_fragments(self):
        # La barra e' sempre visibile: con un prompt attivo mostra la domanda,
        # altrimenti una riga di stato inattivo cosi' il layout non salta mai.
        if self._pending is not None:
            return [("class:question", f"❯ {self._question}")]
        return [("class:idle", "❯ pronto — tasto singolo, / per i comandi, ? guida, Q esci")]

    def _bottom_toolbar(self):
        typed = ""
        if self._input is not None:
            typed = self._input.buffer.document.text
        if typed.startswith("/"):
            options = " │ ".join(cmd for cmd in self.slash_commands if cmd.startswith(typed))
            if options:
                return f" {options} │ ↵ conferma │ Esc annulla "
        if self._pending is not None and self._pending.question:
            tail = "↵ conferma │ Esc annulla"
            if self._pending.quick:
                tail = "s/n oppure ↵ conferma │ Esc annulla"
            elif self._pending.single_key:
                tail = "tasto singolo │ / comandi │ ↵ default"
        else:
            tail = self._hint or "? guida │ Q esci"
        return f" {tail} │ mouse: ruota scorri │ F1 guida "

    def set_status_provider(self, provider: Callable[[], str]):
        self._status_provider = provider

    def set_hint(self, hint: str):
        self._hint = hint
        self._invalidate()

    def set_slash_commands(self, commands: Dict[str, Tuple[str, str]]):
        """Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}."""
        self.slash_commands = dict(commands)
        self._invalidate()

    # ------------------------------------------------------------------
    # Corpo testuale (rendering Rich)
    # ------------------------------------------------------------------
    def append_body(self, text: str):
        if not self.running or self._loop is None:
            self._append_local(text)
            return
        self._loop.call_soon_threadsafe(self._append_local, text)

    def _append_local(self, text: str):
        start_line = self._body_text.count("\n")
        lines = text.split("\n")
        for offset, line in enumerate(lines[:-1] if text.endswith("\n") else lines):
            for label, value in self._clickables:
                if label and label in line:
                    self._click_lines[start_line + offset] = value
        self._body_text += text
        if self._body_buffer is not None:
            self._body_buffer.set_document(
                Document(self._body_text, len(self._body_text)), bypass_readonly=True)
        self._invalidate()

    def clear_body(self):
        if not self.running or self._loop is None:
            self._clear_local()
            return
        self._loop.call_soon_threadsafe(self._clear_local)

    def _clear_local(self):
        self._body_text = ""
        self._click_lines.clear()
        if self._body_buffer is not None:
            self._body_buffer.set_document(Document("", 0), bypass_readonly=True)
        self._invalidate()

    def replace_body(self, renderable):
        """Sostituisce il corpo con il rendering testuale di un oggetto Rich."""
        buf = io.StringIO()
        console = Console(file=buf, force_terminal=False, color_system=None,
                          width=_body_width(), legacy_windows=False)
        console.print(renderable)
        self.clear_body()
        self.append_body(buf.getvalue())

    # ------------------------------------------------------------------
    # Voci cliccabili (mouse)
    # ------------------------------------------------------------------
    def set_clickables(self, items: Iterable[Tuple[str, object]]):
        """Registra etichette cliccabili; il click risolve il prompt con il valore."""
        self._clickables = [(str(label), value) for label, value in items]

    def click_value_for_line(self, line: str):
        for label, value in self._clickables:
            if label and label in line:
                return value
        return None

    # ------------------------------------------------------------------
    # Prompt / confirm / pause (bloccanti, thread-safe)
    # ------------------------------------------------------------------
    def prompt(self, message: str = "hexagon ›", default: Optional[str] = None,
               single_key: bool = False, quick: Optional[Dict[str, object]] = None) -> str:
        if not self.running:
            value = self._prompt_fallback(message, default)
            return self._translate_slash(value)
        if self._pending is not None:
            # Un prompt precedente non e' stato chiuso: interrompilo invece di bloccarti.
            self._pending.resolve(_INTERRUPT)
            self._finish_prompt()
        pending = _PendingPrompt(message, default, single_key, quick)
        self._pending = pending
        self._question = message + (f" [{default}]" if default is not None else "")
        self._default = default
        if self._input is not None:
            self._input.buffer.reset()
        self._invalidate()
        try:
            if self._app is not None and self._loop is not None:
                self._loop.call_soon_threadsafe(self._focus_input)
        except RuntimeError:
            pass
        try:
            # Attesa con watchdog: se il thread UI muore, non restare appeso.
            while not pending.event.wait(0.5):
                if not self.running:
                    pending.resolve(_INTERRUPT)
        finally:
            if self._pending is pending:
                self._pending = None
                self._question = ""
                self._default = None
                if self._input is not None:
                    self._input.buffer.reset()
                self._invalidate()
        if pending.result is _INTERRUPT:
            raise KeyboardInterrupt
        if isinstance(pending.result, bool):
            return pending.result
        return self._translate_slash(str(pending.result if pending.result is not None else ""))

    def _translate_slash(self, value: str) -> str:
        """Converte un comando slash nel tasto/azione equivalente della schermata."""
        stripped = value.strip()
        if stripped.startswith("/") and stripped in self.slash_commands:
            return self.slash_commands[stripped][0]
        return value

    def _focus_input(self):
        if self._app is not None and self._input is not None:
            self._app.layout.focus(self._input)

    def _finish_prompt(self):
        self._pending = None
        self._question = ""
        self._default = None
        if self._input is not None:
            self._input.buffer.reset()
        self._invalidate()

    def resolve_prompt(self, value: object):
        pending = self._pending
        if pending is not None:
            pending.resolve(value)
            self._finish_prompt()

    def _prompt_fallback(self, message: str, default: Optional[str]) -> str:
        suffix = f" [{default}]" if default is not None else ""
        try:
            value = input(f"{message}{suffix} ").strip()
        except EOFError:
            return "q"
        return value if value or default is None else default

    def confirm(self, message: str) -> bool:
        quick = {"s": True, "n": False, "y": True}
        if not self.running:
            return self._prompt_fallback(message + " (si/no)", "no").casefold() in ("si", "sì", "s", "yes", "y")
        answer = self.prompt(message + " (si/no)", "no", quick=quick)
        return bool(answer) if isinstance(answer, bool) else answer.casefold() in ("si", "sì", "s", "yes", "y")

    def pause(self):
        self.prompt("Invio per continuare…", "")

    # ------------------------------------------------------------------
    # Widget di comodo (invariati dalla vecchia interfaccia)
    # ------------------------------------------------------------------
    def result(self, result):
        self.console.print(Panel(Text(result.message), border_style="green" if result.ok else "red"))

    def error(self, error):
        self.console.print(Panel(Text(str(error)), title="Operazione non riuscita", border_style="red"))

    def table(self, title: str, columns: Iterable[str], rows: Iterable[Iterable]):
        table = Table(title=title, border_style="cyan", header_style="bold magenta")
        for column in columns:
            table.add_column(column)
        for row in rows:
            table.add_row(*(str(value) for value in row))
        self.console.print(table)
        return table


class _Suspend:
    def __init__(self, iface: "Interface"):
        self._iface = iface

    def __enter__(self):
        self._iface.stop()
        return self

    def __exit__(self, *exc):
        self._iface.start()
        return False
