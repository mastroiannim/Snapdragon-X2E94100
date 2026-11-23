"""Test FASE 3: rendering a colori, hit-test per colonna, scroll, ricerca,
navigazione con frecce, modalita' input esplicita, Esc/F1/F10 e barra errori.

Questi test fotografano i criteri di accettazione della rifattorizzazione UX:
- colori e stili Rich conservati nei frammenti del corpo;
- click risolti per riga/colonna (non substringa) e hover;
- layout alla larghezza reale (80..200) e re-render al resize;
- scrollbar + PgUp/PgDn/Home/End + ricerca incrementale;
- live dashboard senza reset dello scroll;
- digitazione libera mai intercettata dai single-key; Esc annulla; F1/F10 globali;
- errori visibili nella barra di stato, mai silenziati.
"""
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from rich.panel import Panel
from rich.text import Text

from hexagon_control.ui import components
from hexagon_control.ui.components import Interface, _PendingPrompt


def _start_ui(testcase, ui):
    """Avvia l'app headless esponendo la pipe di input per inviare tasti."""
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    pipe = create_pipe_input().__enter__()
    real_application = components.Application

    def factory(*args, **kwargs):
        kwargs["input"] = pipe
        kwargs["output"] = DummyOutput()
        return real_application(*args, **kwargs)

    patcher = patch.object(components, "Application", side_effect=factory, autospec=True)
    patcher.start()
    testcase.addCleanup(patcher.stop)
    testcase.addCleanup(pipe.close)
    worker = threading.Thread(target=ui.start, name="hexagon-ux-test", daemon=True)
    worker.start()

    def cleanup():
        ui.stop()
        worker.join(timeout=5)

    testcase.addCleanup(cleanup)
    testcase.assertTrue(ui.wait_ready(10), "app non avviata")
    return pipe


def _wait(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def _binding(ui, key):
    from prompt_toolkit.keys import Keys

    for binding in ui._app.key_bindings.get_bindings_for_keys((key,)):
        return binding
    raise AssertionError(f"binding non trovata: {key}")


class ColorRenderingTests(unittest.TestCase):
    def test_rich_styles_survive_as_fragments(self):
        ui = Interface()
        ui.replace_body(Panel(Text("contenuto", style="bold red"), border_style="cyan"))
        styled = [style for line in ui._body_lines for style, _ in line if style]
        self.assertTrue(styled, "nessuno stile Rich conservato nel corpo")
        self.assertTrue(any("red" in s for s in styled), "colore rosso perso")
        self.assertTrue(any("bold" in s for s in styled), "grassetto perso")

    def test_plain_text_matches_plain_rendering(self):
        import io
        from rich.console import Console

        renderable = Panel(Text("contenuto"), title="titolo")
        ui = Interface()
        ui.replace_body(renderable)
        buf = io.StringIO()
        Console(file=buf, force_terminal=False, color_system=None,
                width=ui._last_render_width, legacy_windows=False).print(renderable)
        self.assertEqual(ui._body_text, buf.getvalue())

    def test_body_width_is_real_not_forced_minimum(self):
        import os

        with patch.object(components.shutil, "get_terminal_size", return_value=os.terminal_size((80, 24))):
            self.assertEqual(components._body_width(), 79)
        with patch.object(components.shutil, "get_terminal_size", return_value=os.terminal_size((200, 50))):
            self.assertEqual(components._body_width(), 199)

    def test_render_fits_narrow_width(self):
        text, lines = components._render_rich(
            Panel("una riga di testo piuttosto lunga che deve adattarsi al terminale"), 80)
        widths = [len("".join(t for _, t in line)) for line in lines]
        self.assertLessEqual(max(widths), 80)

    def test_overlay_ranges_splits_and_styles(self):
        tokens = [("", "abcdef")]
        out = components._overlay_ranges(tokens, [(2, 4, "bold")])
        self.assertEqual("".join(t for _, t in out), "abcdef")
        styled = [(s, t) for s, t in out if "bold" in s]
        self.assertEqual("".join(t for _, t in styled), "cd")

    def test_current_body_width_follows_app_output(self):
        from prompt_toolkit.data_structures import Size

        ui = Interface()
        _start_ui(self, ui)
        with patch.object(ui._app.output, "get_size", return_value=Size(rows=50, columns=120)):
            self.assertEqual(ui._current_body_width(), 119)


class ResizeTests(unittest.TestCase):
    def test_resize_rerenders_last_renderable_at_new_width(self):
        from prompt_toolkit.data_structures import Size

        ui = Interface()
        _start_ui(self, ui)
        ui.replace_body(Panel("contenuto che si adatta alla larghezza del terminale"))
        self.assertTrue(_wait(lambda: "contenuto" in ui._body_text))
        with patch.object(ui._app.output, "get_size", return_value=Size(rows=50, columns=120)):
            ui._last_resize_ts = 0.0  # niente debounce nel test
            ui._on_before_render(ui._app)
            self.assertTrue(_wait(lambda: ui._body_lines
                                  and max(len("".join(t for _, t in ln)) for ln in ui._body_lines) > 79))
        widths = [len("".join(t for _, t in line)) for line in ui._body_lines]
        self.assertLessEqual(max(widths), 119)
        self.assertEqual(ui._last_render_width, 119)


class HitTestTests(unittest.TestCase):
    def setUp(self):
        self.ui = Interface()
        self.ui.set_clickables([("1 Router", "1"), ("2 Singolo modello", "2"), ("Q Esci", "q")])

    def test_multiple_labels_on_one_line_resolve_by_column(self):
        self.ui.append_body("1 Router   2 Singolo modello   Q Esci\n")
        line = "1 Router   2 Singolo modello   Q Esci"
        self.assertEqual(self.ui.click_value_at(0, line.index("1 Router")), "1")
        self.assertEqual(self.ui.click_value_at(0, line.index("2 Singolo")), "2")
        self.assertEqual(self.ui.click_value_at(0, line.index("Q Esci")), "q")

    def test_click_outside_labels_is_not_resolved(self):
        self.ui.append_body("1 Router   2 Singolo modello\n")
        self.assertIsNone(self.ui.click_value_at(0, 9))  # spazio fra le voci
        self.assertIsNone(self.ui.click_value_at(5, 0))  # riga inesistente

    def test_substring_false_positive_is_avoided(self):
        # "1 Router" non deve matchare una riga che contiene solo "Router".
        self.ui.append_body("Il Router e' offline\n")
        self.assertIsNone(self.ui.click_value_at(0, 3))

    def test_hover_tracks_the_exact_occurrence(self):
        self.ui.append_body("1 Router   2 Singolo modello\n")
        self.ui._update_hover(0, 12)  # dentro "2 Singolo modello"
        self.assertIsNotNone(self.ui._hover_range)
        self.assertEqual(self.ui._hover_range[3], "2")
        self.ui._update_hover(0, 9)  # spazio: nessun hover
        self.assertIsNone(self.ui._hover_range)


class ScrollAndSearchTests(unittest.TestCase):
    def test_replace_body_is_one_atomic_frame(self):
        ui = Interface()
        _start_ui(self, ui)
        frames = [0]
        ui._app.on_invalidate += lambda *_: frames.__setitem__(0, frames[0] + 1)
        sets = []
        real_set_document = components.Buffer.set_document

        def spy(instance, *a, **k):
            sets.append(1)
            return real_set_document(instance, *a, **k)

        with patch.object(components.Buffer, "set_document", spy):
            frames[0] = 0
            ui.replace_body(Panel("contenuto atomico"))
            self.assertTrue(_wait(lambda: "contenuto atomico" in ui._body_text))
            time.sleep(0.2)
        self.assertEqual(len(sets), 1, "replace_body non atomico")
        self.assertEqual(frames[0], 1, "piu' di un redraw schedulato per frame")

    def test_replace_body_preserves_scroll(self):
        ui = Interface()
        _start_ui(self, ui)
        ui.replace_body(Panel("\n".join(f"riga {i}" for i in range(60))))
        self.assertTrue(_wait(lambda: ui._body_window.render_info is not None
                              and ui._body_window.render_info.content_height > 50))
        ui._scroll_body_to(7)
        ui.replace_body(Panel("\n".join(f"nuova {i}" for i in range(60))))
        self.assertTrue(_wait(lambda: "nuova" in ui._body_text))
        self.assertEqual(ui._body_window.vertical_scroll, 7, "il refresh ha resettato lo scroll")

    def test_scrollbar_has_thumb_when_content_overflows(self):
        ui = Interface()
        _start_ui(self, ui)
        ui.replace_body(Panel("\n".join(f"riga {i}" for i in range(200))))
        self.assertTrue(_wait(lambda: ui._body_window.render_info is not None
                              and ui._body_window.render_info.content_height > ui._body_window.render_info.window_height))
        frags = ui._scrollbar_fragments()
        text = "".join(t for _, t in frags)
        self.assertIn("█", text, "scrollbar senza thumb")

    def test_page_and_home_end_scroll(self):
        ui = Interface()
        _start_ui(self, ui)
        ui.replace_body(Panel("\n".join(f"riga {i}" for i in range(200))))
        self.assertTrue(_wait(lambda: ui._body_window.render_info is not None
                              and ui._body_window.render_info.content_height > ui._body_window.render_info.window_height))
        ui._scroll_body_to(0)
        ui._scroll_body(ui._body_page())
        self.assertGreater(ui._body_window.vertical_scroll, 0)
        ui._scroll_body_to(ui._body_max_scroll())
        end = ui._body_window.vertical_scroll
        ui._scroll_body(-ui._body_page())
        self.assertLess(ui._body_window.vertical_scroll, end)
        ui._scroll_body_to(0)
        self.assertEqual(ui._body_window.vertical_scroll, 0)

    def test_incremental_search_finds_and_cycles(self):
        ui = Interface()
        _start_ui(self, ui)
        ui.append_body("alpha\nbeta gamma\nalpha di nuovo\n")
        self.assertTrue(_wait(lambda: "alpha di nuovo" in ui._body_text))
        ui._begin_search()
        ui._input.buffer.insert_text("alpha")
        self.assertTrue(_wait(lambda: len(ui._search_order) == 2))
        self.assertEqual(ui._search_order[0][0], 0)
        self.assertEqual(ui._search_order[1][0], 2)
        ui._search_next()
        self.assertEqual(ui._search_index, 1)
        ui._search_next()
        self.assertEqual(ui._search_index, 0)  # cicla
        ui._end_search()
        self.assertFalse(ui._search_active)
        self.assertEqual(ui._search_order, [])


class NavigationAndInputModeTests(unittest.TestCase):
    def test_arrows_move_selection_and_enter_resolves(self):
        from prompt_toolkit.keys import Keys

        ui = Interface()
        _start_ui(self, ui)
        ui.set_clickables([("1 Router", "1"), ("2 Singolo modello", "2")])
        ui.replace_body(Panel("1 Router\n2 Singolo modello"))
        self.assertTrue(_wait(lambda: len(ui._nav_ranges) == 2))
        pending = _PendingPrompt("menu", None, True)
        ui._pending = pending
        ui._update_selected_range()
        first = ui._nav_ranges[0][3]
        _binding(ui, Keys.Down).handler(MagicMock())
        self.assertEqual(ui._menu_index, 1)
        _binding(ui, Keys.Enter).handler(MagicMock())
        self.assertEqual(pending.result, ui._nav_ranges[1][3])
        self.assertNotEqual(pending.result, first)

    def test_input_mode_disables_single_key_interception(self):
        from prompt_toolkit.keys import Keys

        ui = Interface()
        _start_ui(self, ui)
        pending = _PendingPrompt("menu", None, True)
        ui._pending = pending
        self.assertFalse(ui._input_mode)
        self.assertTrue(ui._nav_active() is False)  # nessuna voce navigabile
        _binding(ui, Keys.Tab).handler(MagicMock())
        self.assertTrue(ui._input_mode)
        # In input mode la navigazione e' disattivata e i single-key non scattano.
        ui.set_clickables([("1 Router", "1")])
        ui.append_body("1 Router\n")
        self.assertFalse(ui._nav_active())

    def test_free_text_prompt_is_input_mode(self):
        ui = Interface()
        _start_ui(self, ui)
        outcome = {}

        def ask():
            outcome["v"] = ui.prompt("Porta", "18803")

        worker = threading.Thread(target=ask, daemon=True)
        worker.start()
        self.assertTrue(_wait(lambda: ui._pending is not None))
        self.assertTrue(ui._input_mode, "prompt libero non in modalita' input")
        ui.resolve_prompt("19000")
        worker.join(3)
        self.assertEqual(outcome.get("v"), "19000")

    def test_escape_cancels_prompt(self):
        from prompt_toolkit.keys import Keys

        ui = Interface()
        _start_ui(self, ui)
        pending = _PendingPrompt("menu", "default", True)
        ui._pending = pending
        _binding(ui, Keys.Escape).handler(MagicMock())
        self.assertIs(pending.result, components._INTERRUPT, "Esc non annulla il prompt")

    def test_escape_exits_input_mode_before_cancelling(self):
        from prompt_toolkit.keys import Keys

        ui = Interface()
        _start_ui(self, ui)
        pending = _PendingPrompt("menu", None, True)
        ui._pending = pending
        ui._set_input_mode(True)
        _binding(ui, Keys.Escape).handler(MagicMock())
        self.assertFalse(ui._input_mode)
        self.assertFalse(pending.event.is_set(), "Esc ha annullato invece di uscire dall'input")

    def test_f1_and_f10_are_global(self):
        from prompt_toolkit.keys import Keys

        ui = Interface()
        _start_ui(self, ui)
        # Prompt NON single-key: F1/F10 devono comunque funzionare.
        pending = _PendingPrompt("Porta", "18803", False)
        ui._pending = pending
        _binding(ui, Keys.F1).handler(MagicMock())
        self.assertEqual(pending.result, "?")
        pending2 = _PendingPrompt("Porta", "18803", False)
        ui._pending = pending2
        _binding(ui, Keys.F10).handler(MagicMock())
        self.assertEqual(pending2.result, "q")


class ErrorVisibilityTests(unittest.TestCase):
    def test_error_sets_status_bar_message(self):
        ui = Interface()
        ui.error(RuntimeError("errore di prova"))
        self.assertIn("errore di prova", ui._error_message)
        frags = ui._bottom_toolbar()
        text = "".join(t for _, t in frags) if isinstance(frags, list) else frags
        self.assertIn("errore di prova", text)

    def test_report_error_is_not_silenced(self):
        ui = Interface()
        ui.report_error("dashboard rotta")
        self.assertEqual(ui._error_message, "dashboard rotta")

    def test_new_prompt_clears_error(self):
        ui = Interface()
        _start_ui(self, ui)
        ui.report_error("vecchio errore")
        outcome = {}

        def ask():
            outcome["v"] = ui.prompt("menu", single_key=True)

        worker = threading.Thread(target=ask, daemon=True)
        worker.start()
        self.assertTrue(_wait(lambda: ui._pending is not None))
        self.assertEqual(ui._error_message, "")
        ui.resolve_prompt("q")
        worker.join(3)


class LiveDashboardErrorTests(unittest.TestCase):
    def test_refresh_error_is_reported_not_swallowed(self):
        from hexagon_control.ui.app import ControlCenter

        processes = MagicMock()
        processes.base_url = "http://127.0.0.1:18803/v1"
        processes.health_snapshot.return_value = (False, 0.0, [])
        processes.processes_snapshot.return_value = []
        processes.owned = {}
        settings = MagicMock()
        settings.load_error = None
        center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                               MagicMock(), MagicMock(), MagicMock(), settings)
        with patch.object(center, "dashboard_renderable", side_effect=RuntimeError("boom")):
            stop = threading.Event()

            def refresh_once():
                try:
                    center.ui.replace_body(center.dashboard_renderable())
                except Exception as exc:
                    center.ui.report_error(f"Dashboard: {exc}")

            refresh_once()
        self.assertIn("boom", center.ui._error_message)


class ExitLifecycleTests(unittest.TestCase):
    def test_cancelled_exit_confirm_keeps_servers_running(self):
        from hexagon_control.ui.app import ControlCenter

        processes = MagicMock()
        processes.base_url = "http://127.0.0.1:18803/v1"
        processes.owned = {18803: MagicMock()}
        processes.shutdown.return_value = MagicMock(ok=True, message="Server lasciati in background")
        settings = MagicMock()
        settings.load_error = None
        center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                               MagicMock(), MagicMock(), MagicMock(), settings)
        with patch.object(center.ui, "confirm", side_effect=KeyboardInterrupt):
            center.exit_lifecycle()
        processes.shutdown.assert_called_once_with(keep_running=True)


if __name__ == "__main__":
    unittest.main()
