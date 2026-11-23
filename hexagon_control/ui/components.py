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
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Tuple

from prompt_toolkit import Application
from prompt_toolkit.application.run_in_terminal import in_terminal
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
        # Stato del prompt condiviso fra thread UI e thread delle azioni:
        # tutte le transizioni passano da questo lock.
        self._state_lock = threading.Lock()
        # Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}
        self.slash_commands: Dict[str, Tuple[str, str]] = {}
        self._input: Optional[TextArea] = None
        self._app: Optional[Application] = None
        self._loop = None
        self._status_provider: Callable[[], str] = lambda: ""
        # Guard di diagnostica: True mentre viene eseguito un callback di layout
        # (toolbar/fragment). I provider devono leggere solo cache: uno I/O
        # bloccante qui congela l'intera UI a ogni redraw.
        self._in_render = False
        # Handshake di avvio: niente busy-wait, solo eventi.
        self._starting = False
        self._ready = threading.Event()
        self._finished = threading.Event()
        self._ever_ready = False  # l'app e' mai partita con successo in questa sessione
        self._start_thread: Optional[threading.Thread] = None
        self._last_app_error: Optional[Exception] = None
        self._handover_cm = None
        self.history_file = Path.home() / ".hexagon_control_history"

    # ------------------------------------------------------------------
    # Ciclo di vita della full-screen app
    # ------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._ready.is_set()

    def wait_ready(self, timeout: Optional[float] = None) -> bool:
        """Attende che l'app sia pronta senza polling; False su timeout."""
        return self._ready.wait(timeout)

    def start(self):
        """Costruisce ed esegue l'app sul thread chiamante (di norma il main).

        Il loop asyncio dell'application vive sul thread di start(); le
        schermate e le azioni girano su un executor e comunicano con
        ``call_soon_threadsafe`` + eventi. Blocca fino a ``stop()`` o all'uscita
        dall'app. Senza busy-wait: l'avvenuta costruzione è segnalata con
        ``_ready``, il termine con ``_finished``.
        """
        if self._starting or self.running:
            return
        import asyncio

        self._starting = True
        self._finished.clear()
        self._start_thread = threading.current_thread()
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        self._loop.set_exception_handler(self._loop_exception_handler)
        try:
            self._app = self._build_app()
            self._chain_app_exception_handler(self._app)
            self._ever_ready = True
            self._ready.set()
            self._loop.run_until_complete(self._app.run_async())
        except (KeyboardInterrupt, EOFError):
            pass  # uscita volontaria dall'app
        except Exception as exc:  # mai silenziato: traccia su stderr e in memoria
            self._last_app_error = exc
            print(f"hexagon-tui: errore nel loop UI: {exc}", file=sys.stderr)
        finally:
            self._ready.clear()
            self._app = None
            try:
                self._loop.close()
            except Exception:
                pass
            self._loop = None
            self._starting = False
            self._start_thread = None
            self._reject_pending()
            self._finished.set()

    def _chain_app_exception_handler(self, app: Application):
        """Registra gli errori del loop anche con l'handler di prompt_toolkit attivo.

        run_async sostituisce temporaneamente l'exception handler del loop con
        il proprio (che stampa e tiene in vita l'app): lo avvolgiamo per
        conservare l'errore in ``_last_app_error`` senza alterarne il comportamento.
        """
        real_handler = app._handle_exception

        def chained_handler(loop, context):
            self._record_loop_error(context)
            return real_handler(loop, context)

        app._handle_exception = chained_handler

    def _record_loop_error(self, context):
        exc = context.get("exception")
        self._last_app_error = exc if isinstance(exc, Exception) \
            else RuntimeError(str(context.get("message") or "errore nel loop UI"))

    def _loop_exception_handler(self, loop, context):
        # Eccezioni dai callback del loop: mai silenziate, la UI resta attiva.
        self._record_loop_error(context)
        print(f"hexagon-tui: {self._last_app_error}", file=sys.stderr)

    def stop(self, timeout: float = 5.0):
        """Richiede l'uscita dell'app; attende il termine se chiamato da altro thread."""
        app, loop = self._app, self._loop
        if app is not None and loop is not None:
            try:
                loop.call_soon_threadsafe(app.exit)
            except RuntimeError:
                pass
        self._reject_pending()
        if (self._start_thread is not None
                and threading.current_thread() is not self._start_thread):
            self._finished.wait(timeout)

    def suspended(self):
        """Context manager: cede il terminale al corpo senza distruggere l'app.

        Il rendering viene sospeso e l'input staccato (pattern ``in_terminal``
        di prompt_toolkit); al ritorno l'app viene ridisegnata nello stato
        conservato: corpo, scroll e prompt restano intatti, senza uscire
        dall'alternate screen.
        """
        return _Suspend(self)

    def run_in_terminal(self, func: Callable[[], object], in_executor: bool = True) -> object:
        """Esegue ``func`` nel terminale sopra la UI, senza ricreare l'app."""
        if not self.running or self._loop is None or self._app is None:
            return func()
        future = self._run_coroutine_threadsafe(self._run_above(func, in_executor))
        return future.result()

    def _run_coroutine_threadsafe(self, coroutine):
        import asyncio

        return asyncio.run_coroutine_threadsafe(coroutine, self._loop)

    async def _run_above(self, func: Callable[[], object], in_executor: bool):
        from prompt_toolkit.eventloop import run_in_executor_with_context

        async with in_terminal():
            if in_executor:
                return await run_in_executor_with_context(func)
            return func()

    def _begin_handover(self):
        if not self.running or self._loop is None or self._app is None:
            return
        self._handover_cm = in_terminal()
        self._run_coroutine_threadsafe(self._handover_cm.__aenter__()).result()

    def _end_handover(self):
        if self._handover_cm is None:
            return
        cm, self._handover_cm = self._handover_cm, None
        self._run_coroutine_threadsafe(cm.__aexit__(None, None, None)).result()

    def _reject_pending(self):
        with self._state_lock:
            pending, self._pending = self._pending, None
            self._question = ""
            self._default = None
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
        with self._state_lock:
            pending = self._pending
            question = self._question
        if pending is not None:
            return [("class:question", f"❯ {question}")]
        return [("class:idle", "❯ pronto — tasto singolo, / per i comandi, ? guida, Q esci")]

    def _bottom_toolbar(self):
        typed = ""
        if self._input is not None:
            typed = self._input.buffer.document.text
        if typed.startswith("/"):
            options = " │ ".join(cmd for cmd in self.slash_commands if cmd.startswith(typed))
            if options:
                return f" {options} │ ↵ conferma │ Esc annulla "
        with self._state_lock:
            pending = self._pending
        if pending is not None and pending.question:
            tail = "↵ conferma │ Esc annulla"
            if pending.quick:
                tail = "s/n oppure ↵ conferma │ Esc annulla"
            elif pending.single_key:
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
        """Sostituisce il corpo con il rendering testuale di un oggetto Rich.

        Atomico: un solo aggiornamento del documento e un solo invalidate,
        senza frame vuoto intermedio.
        """
        buf = io.StringIO()
        console = Console(file=buf, force_terminal=False, color_system=None,
                          width=_body_width(), legacy_windows=False)
        console.print(renderable)
        text = buf.getvalue()
        if not self.running or self._loop is None:
            self._replace_local(text)
            return
        self._loop.call_soon_threadsafe(self._replace_local, text)

    def _replace_local(self, text: str):
        self._body_text = text
        self._click_lines = self._scan_click_lines(text)
        if self._body_buffer is not None:
            self._body_buffer.set_document(Document(text, len(text)), bypass_readonly=True)
        self._invalidate()

    def _scan_click_lines(self, text: str) -> Dict[int, object]:
        if not self._clickables:
            return {}
        mapping: Dict[int, object] = {}
        for offset, line in enumerate(text.split("\n")):
            value = self.click_value_for_line(line)
            if value is not None:
                mapping[offset] = value
        return mapping

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
        if self._starting and not self.running:
            # start() e' in corso sul suo thread: handshake ad eventi, no polling.
            self._ready.wait(10)
        if not self.running:
            if self._finished.is_set() and self._ever_ready:
                # Sessione UI terminata: non improvvisare un input() su stdin.
                raise KeyboardInterrupt
            value = self._prompt_fallback(message, default)
            return self._translate_slash(value)
        pending = _PendingPrompt(message, default, single_key, quick)
        with self._state_lock:
            previous = self._pending
            self._pending = pending
            self._question = message + (f" [{default}]" if default is not None else "")
            self._default = default
        if previous is not None:
            # Un prompt precedente non e' stato chiuso: interrompilo invece di bloccarti.
            previous.resolve(_INTERRUPT)
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
            with self._state_lock:
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
        with self._state_lock:
            self._pending = None
            self._question = ""
            self._default = None
        if self._input is not None:
            self._input.buffer.reset()
        self._invalidate()

    def resolve_prompt(self, value: object):
        with self._state_lock:
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
    """Cede il terminale al corpo senza distruggere l'app (vedi Interface.suspended)."""

    def __init__(self, iface: "Interface"):
        self._iface = iface

    def __enter__(self):
        self._iface._begin_handover()
        return self

    def __exit__(self, *exc):
        self._iface._end_handover()
        return False
