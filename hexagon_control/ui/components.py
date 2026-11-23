"""Interfaccia full-screen per il Control Center in stile Kilo Code.

Layout fisso su alternate screen (nessuno scroll del terminale), toolbar superiore
di stato, area contenuto scorrevile col mouse, barra domanda + riga di input,
toolbar inferiore con shortcut e suggerimenti contestuali.

Il codice dei menu (Screens/ControlCenter) resta invariato: la classe espone la
stessa API pubblica della vecchia interfaccia a riga di comando (prompt, confirm,
pause, table, result, error, console) con fallback non interattivo quando la
full-screen app non e' attiva (test, pipe, ambienti headless).

Rendering (FASE 3):
- I renderable Rich sono convertiti in ANSI truecolor e poi in frammenti
  prompt_toolkit: colori e stili reali, non piu' testo monocolore.
- Il corpo resta un Buffer (document/scroll atomici) con un lexer che applica gli
  stili per riga e le evidenziazioni dinamiche (hover, selezione menu, ricerca).
- I click sono risolti per riga/colonna sulle occorrenze esatte delle etichette,
  non per substringa; hover ed evidenziazione seguono la selezione.
- Scrollbar, PgUp/PgDn/Home/End e ricerca incrementale; layout ricalcolato al
  resize con debounce e larghezza reale del terminale.
"""

import io
import shutil
import sys
import threading
import time
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
from prompt_toolkit.formatted_text import ANSI, split_lines
from prompt_toolkit.history import FileHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import (
    FormattedTextControl,
    HSplit,
    Layout,
    Window,
)
from prompt_toolkit.layout.controls import BufferControl as _BufferControl
from prompt_toolkit.lexers import Lexer
from prompt_toolkit.mouse_events import MouseButton, MouseEventType
from prompt_toolkit.widgets import TextArea
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

_INTERRUPT = object()

# Stili delle evidenziazioni dinamiche del corpo (attributi inline prompt_toolkit).
_HOVER_STYLE = "bg:#3a3a3a underline"
_SELECTED_STYLE = "bg:#005f5f #ffffff bold"
_SEARCH_STYLE = "bg:#5f5f00 #ffffff"

# Tipo di una riga stilizzata: lista di frammenti (style_string, testo).
StyledLine = List[Tuple[str, str]]


def _terminal_columns() -> int:
    try:
        return shutil.get_terminal_size((100, 30)).columns
    except OSError:
        return 100


def _body_width() -> int:
    """Larghezza reale del corpo (terminale meno la colonna della scrollbar)."""
    return max(20, _terminal_columns() - 1)


def _merge_fragments(fragments: Iterable[Tuple[str, str]]) -> StyledLine:
    """Fonde frammenti adiacenti con lo stesso stile ed elimina quelli vuoti."""
    merged: StyledLine = []
    for style, text in fragments:
        if not text:
            continue
        if merged and merged[-1][0] == style:
            merged[-1] = (style, merged[-1][1] + text)
        else:
            merged.append((style, text))
    return merged


def _render_rich(renderable, width: int) -> Tuple[str, List[StyledLine]]:
    """Renderizza un oggetto Rich in (testo plain, righe stilizzate).

    Il testo plain coincide con il rendering ``color_system=None``: gli stili
    sono solo sequenze SGR aggiunte, ricostruite qui come frammenti.
    """
    buf = io.StringIO()
    console = Console(file=buf, force_terminal=True, color_system="truecolor",
                      width=width, legacy_windows=False)
    console.print(renderable)
    fragments = ANSI(buf.getvalue()).__pt_formatted_text__()
    lines = [_merge_fragments(line) for line in split_lines(fragments)]
    plain = "\n".join("".join(text for _, text in line) for line in lines)
    return plain, lines


def _plain_lines(text: str) -> List[StyledLine]:
    return [[("", line)] for line in text.split("\n")]


def _overlay_ranges(tokens: StyledLine, ranges: List[Tuple[int, int, str]]) -> StyledLine:
    """Applica stili extra a intervalli [start, end) di una riga stilizzata."""
    if not ranges:
        return tokens
    ranges = sorted(ranges)
    result: StyledLine = []
    pos = 0
    ri = 0
    for style, text in tokens:
        local = 0
        while local < len(text):
            abs_start = pos + local
            # Avanza gli intervalli che finiscono prima della posizione corrente.
            while ri < len(ranges) and ranges[ri][1] <= abs_start:
                ri += 1
            active = [r for r in ranges[ri:] if r[0] <= abs_start < r[1]]
            if active:
                end = min(r[1] for r in active) - pos
                extra = " ".join(r[2] for r in active)
                chunk = text[local:end]
                result.append(((style + " " + extra).strip(), chunk))
                local = end
            else:
                next_start = ranges[ri][0] - pos if ri < len(ranges) else len(text)
                end = max(local + 1, min(next_start, len(text)))
                result.append((style, text[local:end]))
                local = end
        pos += len(text)
    return _merge_fragments(result)


class _BodyLexer(Lexer):
    """Lexer che restituisce gli stili Rich per riga + evidenziazioni dinamiche."""

    def __init__(self, iface: "Interface"):
        self._iface = iface

    def lex_document(self, document: Document) -> Callable[[int], StyledLine]:
        iface = self._iface

        def get_line(lineno: int) -> StyledLine:
            if lineno < len(iface._body_lines):
                base = iface._body_lines[lineno]
            else:
                base = [("", document.lines[lineno] if lineno < len(document.lines) else "")]
            ranges: List[Tuple[int, int, str]] = []
            for start, end in iface._search_matches.get(lineno, ()):
                ranges.append((start, end, _SEARCH_STYLE))
            hovered = iface._hover_range
            if hovered is not None and hovered[0] == lineno:
                ranges.append((hovered[1], hovered[2], _HOVER_STYLE))
            selected = iface._selected_range
            if selected is not None and selected[0] == lineno:
                ranges.append((selected[1], selected[2], _SELECTED_STYLE))
            return _overlay_ranges(base, ranges)

        return get_line

    def invalidation_hash(self) -> int:
        # Cambia quando cambiano hover/selezione/ricerca, cosi' la cache dei
        # frammenti di BufferControl si aggiorna anche a testo invariato.
        return self._iface._style_version


class _BodyControl(_BufferControl):
    """BufferControl con click per riga/colonna, hover e scroll del corpo."""

    def __init__(self, iface: "Interface", **kwargs):
        super().__init__(**kwargs)
        self._iface = iface

    def mouse_handler(self, mouse_event):
        iface = self._iface
        line = mouse_event.position.y
        col = mouse_event.position.x
        if mouse_event.event_type == MouseEventType.MOUSE_MOVE:
            if mouse_event.button == MouseButton.NONE:
                iface._update_hover(line, col)
            return NotImplemented
        if mouse_event.event_type == MouseEventType.MOUSE_UP:
            value = iface.click_value_at(line, col)
            if value is not None:
                iface.resolve_prompt(value)
                return None
        return super().mouse_handler(mouse_event)


class _BodyConsole(Console):
    """Console Rich che renderizza nel corpo della full-screen app a colori."""

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
        # Rendering truecolor nel corpo: gli stili Rich sono conservati.
        self.width = self._iface._current_body_width()
        buf = io.StringIO()
        console = Console(file=buf, force_terminal=True, color_system="truecolor",
                          width=self.width, legacy_windows=False)
        console.print(*args, **kwargs)
        fragments = ANSI(buf.getvalue()).__pt_formatted_text__()
        lines = [_merge_fragments(line) for line in split_lines(fragments)]
        text = "\n".join("".join(t for _, t in line) for line in lines)
        if text:
            self._iface._append_rendered(text, lines)

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
        self._body_lines: List[StyledLine] = []
        self._body_buffer: Optional[Buffer] = None
        self._body_window: Optional[Window] = None
        self._clickables: List[Tuple[str, object]] = []
        self._click_lines: Dict[int, object] = {}
        # Occorrenze esatte (riga, start, end, valore) per il click per colonna.
        self._click_ranges: List[Tuple[int, int, int, object]] = []
        self._nav_ranges: List[Tuple[int, int, int, object]] = []
        self._menu_index = 0
        self._hover_range: Optional[Tuple[int, int, int, object]] = None
        self._selected_range: Optional[Tuple[int, int, int, object]] = None
        self._search_matches: Dict[int, List[Tuple[int, int]]] = {}
        self._search_order: List[Tuple[int, int, int]] = []
        self._search_index = 0
        self._search_active = False
        self._style_version = 0
        self._hint = ""
        self._question = ""
        self._default: Optional[str] = None
        self._pending: Optional[_PendingPrompt] = None
        # Stato del prompt condiviso fra thread UI e thread delle azioni:
        # tutte le transizioni passano da questo lock.
        self._state_lock = threading.Lock()
        # Modalita' input esplicita: nei prompt single-key la digitazione libera
        # avviene solo in input mode, cosi' i tasti singoli non la intercettano.
        self._input_mode = False
        # Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}
        self.slash_commands: Dict[str, Tuple[str, str]] = {}
        self._input: Optional[TextArea] = None
        self._app: Optional[Application] = None
        self._loop = None
        self._status_provider: Callable[[], str] = lambda: ""
        self._help_callback: Optional[Callable[[], None]] = None
        self._error_message = ""
        # Guard di diagnostica: True mentre viene eseguito un callback di layout
        # (toolbar/fragment). I provider devono leggere solo cache: uno I/O
        # bloccante qui congela l'intera UI a ogni redraw.
        self._in_render = False
        # Resize: ultimo renderable e larghezza, per il re-render con debounce.
        self._last_renderable = None
        self._last_render_width = _body_width()
        self._last_resize_ts = 0.0
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
        """Sostituisce l'handler di prompt_toolkit con uno headless-safe.

        L'handler predefinito stampa la traccia e attende Invio creando una
        ``PromptSession`` su console reale: in headless (pipe/DummyOutput) cio'
        solleva ``NoConsoleScreenBufferError`` a cascata. Qui registriamo
        l'errore e lo stampiamo su stderr senza toccare la console; l'app resta
        attiva.
        """
        def safe_handler(loop, context):
            self._record_loop_error(context)
            self._print_loop_error(context)

        app._handle_exception = safe_handler

    def _record_loop_error(self, context):
        exc = context.get("exception")
        self._last_app_error = exc if isinstance(exc, Exception) \
            else RuntimeError(str(context.get("message") or "errore nel loop UI"))

    def _print_loop_error(self, context):
        import traceback

        exc = context.get("exception")
        message = context.get("message") or "errore nel loop UI"
        print(f"hexagon-tui: {message}: {exc}", file=sys.stderr)
        if exc is not None and exc.__traceback__ is not None:
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)

    def _loop_exception_handler(self, loop, context):
        # Eccezioni dai callback del loop: mai silenziate, la UI resta attiva.
        self._record_loop_error(context)
        self._print_loop_error(context)

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
        """Context manager: cede il terminale al corpo senza distruggere l'app."""
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
            self._input_mode = False
            self._search_active = False
        if pending is not None:
            pending.resolve(_INTERRUPT)

    def _invalidate(self):
        if self._app is not None:
            self._call_soon(self._app.invalidate)

    def _call_soon(self, func, *args):
        """Schedula ``func`` sul loop UI nel contesto dell'app session.

        Le chiamate cross-thread altrimenti perdono il contesto: il redraw
        accederebbe a ``DummyApplication.output`` creando un Win32Output di
        default (errore in headless). Il contesto catturato da ``run_async``
        (``app.context``) contiene l'app session con l'output corretto.
        """
        app, loop = self._app, self._loop
        if app is None or loop is None:
            return

        def runner():
            func(*args)

        context = getattr(app, "context", None)
        try:
            if context is not None:
                loop.call_soon_threadsafe(context.copy().run, runner)
            else:
                from prompt_toolkit.application.current import set_app

                def wrapped():
                    with set_app(app):
                        func(*args)

                loop.call_soon_threadsafe(wrapped)
        except RuntimeError:
            pass

    def _current_body_width(self) -> int:
        if self._app is not None:
            try:
                return max(20, self._app.output.get_size().columns - 1)
            except Exception:
                pass
        return _body_width()

    # ------------------------------------------------------------------
    # Costruzione layout e key bindings
    # ------------------------------------------------------------------
    def _build_app(self) -> Application:
        self._body_buffer = Buffer(read_only=True)
        if self._body_text:
            self._body_buffer.set_document(
                Document(self._body_text, len(self._body_text)), bypass_readonly=True)

        body_control = _BodyControl(self, buffer=self._body_buffer,
                                    lexer=_BodyLexer(self), focusable=False)
        body = Window(
            body_control,
            wrap_lines=False,
            allow_scroll_beyond_bottom=True,
            always_hide_cursor=True,
        )
        self._body_window = body
        scrollbar = Window(
            FormattedTextControl(self._scrollbar_fragments, focusable=False),
            width=1,
            style="class:scrollbar",
        )
        body_row = HSplit([body, scrollbar])

        self._input = TextArea(
            multiline=False,
            prompt="",
            history=FileHistory(str(self.history_file)) if self.history_file else None,
            auto_suggest=AutoSuggestFromHistory(),
            completer=_SlashCompleter(self),
            complete_while_typing=True,
            style="class:input",
        )
        self._input.buffer.on_text_changed += self._on_input_text_changed

        input_focused = has_focus(self._input)

        kb = KeyBindings()

        @kb.add("enter", eager=True)
        def _accept(event):
            if self._search_active:
                self._search_next()
                return
            pending = self._pending
            if pending is None:
                return
            value = self._input.buffer.document.text.strip()
            if not value and pending.single_key and self._nav_ranges:
                # Navigazione con frecce: Invio attiva la voce selezionata.
                self.resolve_prompt(self._nav_ranges[self._menu_index][3])
                return
            pending.resolve(value if value or pending.default is None else pending.default)
            self._finish_prompt()

        @kb.add("escape", eager=True)
        def _cancel(event):
            if self._search_active:
                self._end_search()
                return
            if self._input_mode:
                # Esc esce prima dalla modalita' input, senza annullare il prompt.
                self._set_input_mode(False)
                if self._input is not None:
                    self._input.buffer.reset()
                return
            pending = self._pending
            if pending is None:
                return
            # Esc annulla davvero: interrompe il prompt corrente.
            pending.resolve(_INTERRUPT)
            self._finish_prompt()

        @kb.add("c-c", eager=True)
        def _interrupt(event):
            if self._search_active:
                self._end_search()
                return
            if self._pending is not None:
                self._pending.resolve(_INTERRUPT)
                self._finish_prompt()

        @kb.add("c-l", eager=True)
        def _clear(event):
            self.clear_body()

        @kb.add("c-f", eager=True)
        def _search(event):
            self._begin_search()

        @kb.add("f1", eager=True)
        def _help(event):
            if self._pending is not None:
                self._pending.resolve("?")
                self._finish_prompt()
            elif self._help_callback is not None:
                self._help_callback()

        @kb.add("f10", eager=True)
        def _quit(event):
            if self._pending is not None:
                self._pending.resolve("q")
                self._finish_prompt()

        @kb.add("tab", eager=True)
        def _enter_input_mode(event):
            if self._pending is not None and self._pending.single_key:
                self._set_input_mode(True)

        # Scroll del corpo: PgUp/PgDn sempre; Home/End solo a input vuoto,
        # cosi' l'editing del testo nella riga di input resta intatto.
        @kb.add("pageup", eager=True)
        def _pageup(event):
            self._scroll_body(-self._body_page())

        @kb.add("pagedown", eager=True)
        def _pagedown(event):
            self._scroll_body(self._body_page())

        @kb.add("home", eager=True, filter=Condition(lambda: not self._input_text()))
        def _home(event):
            self._scroll_body_to(0)

        @kb.add("end", eager=True, filter=Condition(lambda: not self._input_text()))
        def _end(event):
            self._scroll_body_to(self._body_max_scroll())

        # Navigazione del menu con le frecce (prompt single-key con voci).
        nav_active = Condition(lambda: self._nav_active())

        @kb.add("up", eager=True, filter=nav_active)
        def _nav_up(event):
            self._move_selection(-1)

        @kb.add("down", eager=True, filter=nav_active)
        def _nav_down(event):
            self._move_selection(1)

        def _quick_key(char: str):
            def _active() -> bool:
                # Filtro preciso: la binding matcha SOLO quando il tasto
                # risolve davvero il prompt in modalita' navigazione; altrimenti
                # il tasto prosegue ai binding di default (inserimento testo).
                pending = self._pending
                if pending is None or self._input is None:
                    return False
                if self._search_active or self._input_mode:
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
                body_row,
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
        app.before_render += self._on_before_render
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
            "error": "ansired bold",
            "scrollbar": "ansibrightblack",
            "question-bar": "",
            "input": "",
        })

    # ------------------------------------------------------------------
    # Resize (debounce) e scroll del corpo
    # ------------------------------------------------------------------
    def _on_before_render(self, app: Application):
        try:
            columns = app.output.get_size().columns
        except Exception:
            return
        width = max(20, columns - 1)
        if width != self._last_render_width and self._last_renderable is not None:
            now = time.monotonic()
            if now - self._last_resize_ts >= 0.15:
                self._last_resize_ts = now
                self._last_render_width = width
                self._call_soon(self._rerender_last)

    def _rerender_last(self):
        if self._last_renderable is not None:
            self.replace_body(self._last_renderable)

    def _body_page(self) -> int:
        info = self._body_window.render_info if self._body_window is not None else None
        return max(1, (info.window_height - 1) if info is not None else 10)

    def _body_max_scroll(self) -> int:
        info = self._body_window.render_info if self._body_window is not None else None
        if info is None:
            return 0
        return max(0, info.content_height - info.window_height)

    def _scroll_body(self, delta: int):
        if self._body_window is None:
            return
        self._scroll_body_to(self._body_window.vertical_scroll + delta)

    def _scroll_body_to(self, value: int):
        if self._body_window is None:
            return
        self._body_window.vertical_scroll = max(0, min(value, self._body_max_scroll()))
        self._sync_body_cursor()
        self._invalidate()

    def _sync_body_cursor(self):
        """Mantiene il cursore del corpo alla prima riga visibile.

        Il Window porta sempre il cursore in vista a ogni render: tenendolo
        all'inizio della finestra visibile, lo scroll scelto dall'utente (o dal
        refresh del dashboard) non viene resettato ne' riportato in fondo.
        """
        if self._body_buffer is None or self._body_window is None:
            return
        document = self._body_buffer.document
        line = min(self._body_window.vertical_scroll, max(0, document.line_count - 1))
        self._body_buffer.cursor_position = document.translate_row_col_to_index(line, 0)

    def _scrollbar_fragments(self):
        info = self._body_window.render_info if self._body_window is not None else None
        if info is None:
            return [("", " ")]
        height = info.window_height
        content = info.content_height
        if height <= 0:
            return [("", " ")]
        if content <= height:
            return [("class:scrollbar", "\n".join([" "] * height))]
        thumb = max(1, int(height * height / content))
        span = max(1, content - height)
        pos = int((info.vertical_scroll / span) * (height - thumb))
        pos = max(0, min(pos, height - thumb))
        rows = ["│"] * height
        for i in range(pos, pos + thumb):
            rows[i] = "█"
        return [("class:scrollbar", "\n".join(rows))]

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
        if self._search_active:
            query = self._input_text()
            count = len(self._search_order)
            return [("class:question", f"🔎 Cerca: {query} │ {count} risultati │ Invio prossimo │ Esc fine")]
        with self._state_lock:
            pending = self._pending
            question = self._question
            input_mode = self._input_mode
        if pending is not None:
            mode = " [INPUT]" if input_mode else ""
            return [("class:question", f"❯ {question}{mode}")]
        return [("class:idle", "❯ pronto — tasto singolo, / per i comandi, ? guida, Q esci")]

    def _bottom_toolbar(self):
        if self._error_message:
            return [("class:error", f" ⚠ {self._error_message} ")]
        typed = self._input_text()
        if typed.startswith("/"):
            options = " │ ".join(cmd for cmd in self.slash_commands if cmd.startswith(typed))
            if options:
                return f" {options} │ ↵ conferma │ Esc annulla "
        with self._state_lock:
            pending = self._pending
            input_mode = self._input_mode
        if pending is not None and pending.question:
            if input_mode:
                tail = "modalità input: digita liberamente │ ↵ conferma │ Esc esci"
            elif pending.quick:
                tail = "s/n oppure ↵ conferma │ Esc annulla"
            elif pending.single_key:
                tail = "frecce+Invio o tasto singolo │ Tab/ / digita │ Esc annulla"
            else:
                tail = "↵ conferma │ Esc annulla"
        else:
            tail = self._hint or "? guida │ Q esci"
        return f" {tail} │ Ctrl+F cerca │ PgUp/PgDn scorri │ F1 guida "

    def set_status_provider(self, provider: Callable[[], str]):
        self._status_provider = provider

    def set_help_callback(self, callback: Callable[[], None]):
        self._help_callback = callback

    def set_hint(self, hint: str):
        self._hint = hint
        self._invalidate()

    def report_error(self, message: str):
        """Mostra un errore nella barra di stato (mai silenziato)."""
        self._error_message = str(message)
        self._invalidate()

    def set_slash_commands(self, commands: Dict[str, Tuple[str, str]]):
        """Comandi slash contestuali: {"/comando": (tasto_equivalente, descrizione)}."""
        self.slash_commands = dict(commands)
        self._invalidate()

    # ------------------------------------------------------------------
    # Corpo testuale (rendering Rich a colori)
    # ------------------------------------------------------------------
    def append_body(self, text: str):
        self._append_rendered(text, _plain_lines(text))

    def _append_rendered(self, text: str, lines: List[StyledLine]):
        if not self.running or self._loop is None:
            self._append_local(text, lines)
            return
        self._call_soon(self._append_local, text, lines)

    def _append_local(self, text: str, lines: List[StyledLine]):
        start_line = self._body_text.count("\n")
        self._body_text += text
        self._body_lines.extend(lines)
        self._register_clicks(text, start_line)
        if self._body_buffer is not None:
            self._body_buffer.set_document(
                Document(self._body_text, len(self._body_text)), bypass_readonly=True)
        self._refresh_navigation()
        self._invalidate()

    def clear_body(self):
        if not self.running or self._loop is None:
            self._clear_local()
            return
        self._call_soon(self._clear_local)

    def _clear_local(self):
        self._body_text = ""
        self._body_lines = []
        self._click_lines.clear()
        self._click_ranges = []
        self._search_matches = {}
        self._search_order = []
        self._hover_range = None
        self._selected_range = None
        if self._body_buffer is not None:
            self._body_buffer.set_document(Document("", 0), bypass_readonly=True)
        self._refresh_navigation()
        self._invalidate()

    def replace_body(self, renderable):
        """Sostituisce il corpo con il rendering a colori di un oggetto Rich.

        Atomico: un solo aggiornamento del documento e un solo invalidate,
        senza frame vuoto intermedio. Lo scroll corrente e' conservato.
        """
        self._last_renderable = renderable
        width = self._current_body_width()
        self._last_render_width = width
        text, lines = _render_rich(renderable, width)
        if not self.running or self._loop is None:
            self._replace_local(text, lines)
            return
        self._call_soon(self._replace_local, text, lines)

    def _replace_local(self, text: str, lines: List[StyledLine]):
        scroll = self._body_window.vertical_scroll if self._body_window is not None else 0
        self._body_text = text
        self._body_lines = lines
        self._click_lines = self._scan_click_lines(text)
        self._click_ranges = self._scan_click_ranges(text)
        self._hover_range = None
        if self._body_buffer is not None:
            # Un solo set_document atomico: il cursore va alla riga di scroll
            # conservata, cosi' il Window non riporta la vista in fondo. Il
            # redraw e' pilotato dall'evento del buffer (un solo frame).
            document = Document(text, 0)
            line = min(scroll, max(0, document.line_count - 1))
            cursor = document.translate_row_col_to_index(line, 0)
            self._body_buffer.set_document(Document(text, cursor), bypass_readonly=True)
        if self._body_window is not None:
            self._body_window.vertical_scroll = scroll
        self._refresh_navigation()
        if self._search_active:
            self._compute_search_matches()
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

    def _scan_click_ranges(self, text: str) -> List[Tuple[int, int, int, object]]:
        """Occorrenze esatte di ogni etichetta cliccabile, per riga e colonna."""
        ranges: List[Tuple[int, int, int, object]] = []
        if not self._clickables:
            return ranges
        for offset, line in enumerate(text.split("\n")):
            for label, value in self._clickables:
                if not label:
                    continue
                start = line.find(label)
                while start != -1:
                    ranges.append((offset, start, start + len(label), value))
                    start = line.find(label, start + 1)
        ranges.sort(key=lambda r: (r[0], r[1]))
        return ranges

    def _register_clicks(self, text: str, start_line: int):
        lines = text.split("\n")
        for offset, line in enumerate(lines[:-1] if text.endswith("\n") else lines):
            for label, value in self._clickables:
                if label and label in line:
                    self._click_lines[start_line + offset] = value
        self._click_ranges = self._scan_click_ranges(self._body_text)

    # ------------------------------------------------------------------
    # Voci cliccabili (mouse) e navigazione
    # ------------------------------------------------------------------
    def set_clickables(self, items: Iterable[Tuple[str, object]]):
        """Registra etichette cliccabili; il click risolve il prompt con il valore."""
        self._clickables = [(str(label), value) for label, value in items]
        self._click_ranges = self._scan_click_ranges(self._body_text)
        self._refresh_navigation()
        self._invalidate()

    def click_value_for_line(self, line: str):
        for label, value in self._clickables:
            if label and label in line:
                return value
        return None

    def click_value_at(self, line: int, col: int):
        """Hit-test per riga/colonna: l'occorrenza esatta che contiene il click."""
        best = None
        for row, start, end, value in self._click_ranges:
            if row == line and start <= col < end:
                if best is None or (end - start) > (best[2] - best[1]):
                    best = (row, start, end, value)
        return best[3] if best is not None else None

    def _update_hover(self, line: int, col: int):
        found = None
        for row, start, end, value in self._click_ranges:
            if row == line and start <= col < end:
                found = (row, start, end, value)
                break
        if found != self._hover_range:
            self._hover_range = found
            self._style_version += 1
            self._invalidate()

    def _refresh_navigation(self):
        # Voci navigabili con le frecce: occorrenze cliccabili presenti nel corpo.
        self._nav_ranges = list(self._click_ranges)
        if self._menu_index >= len(self._nav_ranges):
            self._menu_index = 0
        self._update_selected_range()

    def _update_selected_range(self):
        if self._nav_ranges and self._nav_active():
            self._selected_range = self._nav_ranges[self._menu_index]
        else:
            self._selected_range = None
        self._style_version += 1

    def _nav_active(self) -> bool:
        with self._state_lock:
            pending = self._pending
        return (pending is not None and pending.single_key
                and bool(self._nav_ranges) and not self._input_mode
                and not self._search_active)

    def _move_selection(self, delta: int):
        if not self._nav_ranges:
            return
        self._menu_index = (self._menu_index + delta) % len(self._nav_ranges)
        self._update_selected_range()
        row = self._nav_ranges[self._menu_index][0]
        info = self._body_window.render_info if self._body_window is not None else None
        if info is not None and self._body_window is not None:
            top = self._body_window.vertical_scroll
            if row < top:
                self._body_window.vertical_scroll = row
            elif row >= top + info.window_height:
                self._body_window.vertical_scroll = row - info.window_height + 1
            self._sync_body_cursor()
        self._invalidate()

    # ------------------------------------------------------------------
    # Ricerca incrementale nel corpo
    # ------------------------------------------------------------------
    def _input_text(self) -> str:
        return self._input.buffer.document.text if self._input is not None else ""

    def _on_input_text_changed(self, buffer: Buffer):
        if self._search_active:
            self._compute_search_matches()
            if self._search_order:
                self._search_index = 0
                self._jump_to_search(self._search_order[0])
            self._invalidate()

    def _begin_search(self):
        self._search_active = True
        self._search_matches = {}
        self._search_order = []
        self._search_index = 0
        if self._input is not None:
            self._input.buffer.reset()
            self._focus_input()
        self._invalidate()

    def _end_search(self):
        self._search_active = False
        self._search_matches = {}
        self._search_order = []
        if self._input is not None:
            self._input.buffer.reset()
        self._style_version += 1
        self._invalidate()

    def _compute_search_matches(self):
        query = self._input_text()
        self._search_matches = {}
        self._search_order = []
        if not query:
            self._style_version += 1
            return
        needle = query.casefold()
        for offset, line in enumerate(self._body_text.split("\n")):
            hay = line.casefold()
            start = hay.find(needle)
            while start != -1:
                self._search_matches.setdefault(offset, []).append((start, start + len(query)))
                self._search_order.append((offset, start, start + len(query)))
                start = hay.find(needle, start + 1)
        self._style_version += 1

    def _search_next(self):
        if not self._search_order:
            return
        self._search_index = (self._search_index + 1) % len(self._search_order)
        self._jump_to_search(self._search_order[self._search_index])
        self._invalidate()

    def _jump_to_search(self, match: Tuple[int, int, int]):
        if self._body_window is None:
            return
        info = self._body_window.render_info
        height = info.window_height if info is not None else 10
        self._body_window.vertical_scroll = max(0, min(match[0] - height // 2, self._body_max_scroll()))
        self._sync_body_cursor()

    # ------------------------------------------------------------------
    # Modalita' input
    # ------------------------------------------------------------------
    def _set_input_mode(self, active: bool):
        with self._state_lock:
            self._input_mode = active
        self._update_selected_range()
        self._invalidate()

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
            self._input_mode = not single_key
            self._search_active = False
        self._error_message = ""
        if previous is not None:
            # Un prompt precedente non e' stato chiuso: interrompilo invece di bloccarti.
            previous.resolve(_INTERRUPT)
        if self._input is not None:
            self._input.buffer.reset()
        self._update_selected_range()
        self._invalidate()
        try:
            if self._app is not None and self._loop is not None:
                self._call_soon(self._focus_input)
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
                    self._input_mode = False
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
            self._input_mode = False
        if self._input is not None:
            self._input.buffer.reset()
        self._update_selected_range()
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
        self.report_error(str(error))
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
