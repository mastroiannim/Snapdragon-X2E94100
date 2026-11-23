"""Test headless per l'interfaccia full-screen del Control Center."""
import time
import unittest
from unittest.mock import MagicMock, patch

from rich.panel import Panel
from rich.table import Table

from hexagon_control.ui import components
from hexagon_control.ui.app import ControlCenter, MENU_SLASH
from hexagon_control.ui.components import Interface, _PendingPrompt


class InterfaceRenderingTests(unittest.TestCase):
    def setUp(self):
        self.ui = Interface()

    def test_console_print_renders_rich_as_plain_text_in_body(self):
        self.ui.console.print(Panel("contenuto", title="titolo"))
        self.assertIn("contenuto", self.ui._body_text)

    def test_console_table_renders_columns_and_rows(self):
        table = Table("Colonna")
        table.add_row("valore")
        self.ui.console.print(table)
        self.assertIn("Colonna", self.ui._body_text)
        self.assertIn("valore", self.ui._body_text)

    def test_console_print_end_empty_does_not_add_newline(self):
        self.ui.console.print("pezzo", end="")
        self.assertEqual(self.ui._body_text, "pezzo")

    def test_console_clear_empties_body(self):
        self.ui.console.print("da cancellare")
        self.ui.console.clear()
        self.assertEqual(self.ui._body_text, "")

    def test_replace_body_swaps_content(self):
        self.ui.console.print("vecchio")
        self.ui.replace_body(Panel("nuovo"))
        self.assertNotIn("vecchio", self.ui._body_text)
        self.assertIn("nuovo", self.ui._body_text)

    def test_toolbar_callables_return_valid_formatted_text(self):
        from prompt_toolkit.formatted_text import to_formatted_text

        self.ui._question = "hexagon ›"
        self.assertIsNotNone(to_formatted_text(self.ui._question_fragments()))
        self.assertIsNotNone(to_formatted_text(self.ui._top_toolbar()))
        self.assertIsNotNone(to_formatted_text(self.ui._bottom_toolbar()))


class ClickableTests(unittest.TestCase):
    def setUp(self):
        self.ui = Interface()

    def test_click_value_matches_registered_label(self):
        self.ui.set_clickables([("4 Kilo Code", "4"), ("Q Esci", "q")])
        self.assertEqual(self.ui.click_value_for_line("4 Kilo Code   avvia il frontend"), "4")
        self.assertEqual(self.ui.click_value_for_line("... Q Esci"), "q")
        self.assertIsNone(self.ui.click_value_for_line("riga senza voci"))

    def test_clickable_lines_are_tracked_on_append(self):
        self.ui.set_clickables([("4 Kilo Code", "4")])
        self.ui.append_body("intro\n4 Kilo Code\noutro\n")
        self.assertEqual(self.ui._click_lines.get(1), "4")

    def test_clear_body_resets_clickable_lines(self):
        self.ui.set_clickables([("4 Kilo Code", "4")])
        self.ui.append_body("4 Kilo Code\n")
        self.ui.clear_body()
        self.assertEqual(self.ui._click_lines, {})


class PromptMechanicsTests(unittest.TestCase):
    def test_pending_prompt_resolve_wakes_waiter(self):
        pending = _PendingPrompt("domanda", None, True)
        with patch.object(pending.event, "wait", return_value=None):
            pending.resolve("4")
            self.assertTrue(pending.event.is_set())
            self.assertEqual(pending.result, "4")

    def test_resolve_prompt_resolves_pending(self):
        ui = Interface()
        pending = _PendingPrompt("menu", None, True)
        ui._pending = pending
        ui.resolve_prompt("4")
        self.assertEqual(pending.result, "4")
        self.assertIsNone(ui._pending)

    def test_resolve_prompt_without_pending_is_noop(self):
        ui = Interface()
        ui.resolve_prompt("4")  # non deve sollevare

    def test_reject_pending_sends_interrupt(self):
        ui = Interface()
        pending = _PendingPrompt("menu", None, True)
        ui._pending = pending
        ui._reject_pending()
        self.assertIs(pending.result, components._INTERRUPT)


class FallbackPromptTests(unittest.TestCase):
    def setUp(self):
        self.ui = Interface()

    def test_prompt_fallback_uses_input(self):
        with patch("builtins.input", return_value="router"):
            self.assertEqual(self.ui.prompt("hexagon ›"), "router")

    def test_prompt_fallback_applies_default_on_empty(self):
        with patch("builtins.input", return_value=""):
            self.assertEqual(self.ui.prompt("Porta", "18803"), "18803")

    def test_prompt_fallback_eof_returns_q(self):
        with patch("builtins.input", side_effect=EOFError):
            self.assertEqual(self.ui.prompt("hexagon ›"), "q")

    def test_confirm_fallback_accepts_s(self):
        with patch("builtins.input", return_value="s"):
            self.assertTrue(self.ui.confirm("Proseguire?"))

    def test_confirm_fallback_default_no(self):
        with patch("builtins.input", return_value=""):
            self.assertFalse(self.ui.confirm("Proseguire?"))


class FullScreenLoopTests(unittest.TestCase):
    """Regressione: il loop di marshaling deve essere quello dell'app.

    Application.run() crea un loop proprio con asyncio.run(); se la classe
    Interface usasse un loop diverso per call_soon_threadsafe, corpo e domande
    non verrebbero mai aggiornati (TUI con body vuoto, tastiera funzionante).
    """

    def test_body_updates_reach_the_running_app(self):
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput

        with create_pipe_input() as pipe:
            real_application = components.Application

            def factory(*args, **kwargs):
                kwargs["input"] = pipe
                kwargs["output"] = DummyOutput()
                return real_application(*args, **kwargs)

            ui = Interface()
            with patch.object(components, "Application", side_effect=factory, autospec=True):
                ui.start()
                try:
                    deadline = time.time() + 10
                    while (ui._app is None or not ui.running) and time.time() < deadline:
                        time.sleep(0.05)
                    self.assertTrue(ui.running, "full-screen app non avviata nel test")
                    ui.append_body("CONTENUTO DI PROVA\n")
                    deadline = time.time() + 5
                    while "CONTENUTO DI PROVA" not in ui._body_text and time.time() < deadline:
                        time.sleep(0.05)
                    self.assertIn("CONTENUTO DI PROVA", ui._body_text)
                    self.assertIsNotNone(ui._body_buffer)
                    self.assertIn("CONTENUTO DI PROVA", ui._body_buffer.document.text)
                finally:
                    ui.stop()


class SlashModeTests(unittest.TestCase):
    def setUp(self):
        self.ui = Interface()

    def test_translate_slash_maps_to_key(self):
        self.ui.set_slash_commands({"/avvia": ("a", "Avvia"), "/indietro": ("b", "Indietro")})
        self.assertEqual(self.ui._translate_slash("/avvia"), "a")
        self.assertEqual(self.ui._translate_slash("  /indietro "), "b")

    def test_translate_slash_leaves_other_input_untouched(self):
        self.ui.set_slash_commands({"/avvia": ("a", "Avvia")})
        self.assertEqual(self.ui._translate_slash("router"), "router")
        self.assertEqual(self.ui._translate_slash("/sconosciuto"), "/sconosciuto")
        self.assertEqual(self.ui._translate_slash(""), "")

    def test_completer_offers_contextual_commands(self):
        from prompt_toolkit.document import Document

        self.ui.set_slash_commands({"/avvia": ("a", "Avvia"), "/stop": ("s", "Arresta")})
        completer = components._SlashCompleter(self.ui)
        results = [c.text for c in completer.get_completions(Document("/a"), None)]
        self.assertIn("/avvia", results)
        self.assertNotIn("/stop", results)
        all_results = [c.text for c in completer.get_completions(Document("/"), None)]
        self.assertEqual(len(all_results), 2)

    def test_completer_ignores_non_slash_input(self):
        from prompt_toolkit.document import Document

        self.ui.set_slash_commands({"/avvia": ("a", "Avvia")})
        completer = components._SlashCompleter(self.ui)
        self.assertEqual(list(completer.get_completions(Document("av"), None)), [])

    def test_question_bar_always_returns_fragments(self):
        idle = self.ui._question_fragments()
        self.assertEqual(len(idle), 1)
        self.assertTrue(idle[0][1].startswith("❯"))
        self.ui._pending = components._PendingPrompt("hexagon ›", None, True)
        self.ui._question = "hexagon ›"
        active = self.ui._question_fragments()
        self.assertIn("hexagon ›", active[0][1])


class SuspendTests(unittest.TestCase):
    def test_suspend_stops_and_restarts(self):
        ui = Interface()
        with patch.object(ui, "stop") as stop, patch.object(ui, "start") as start:
            with ui.suspended():
                pass
        stop.assert_called_once()
        start.assert_called_once()


class ControlCenterDispatchTests(unittest.TestCase):
    def _app(self):
        processes = MagicMock()
        processes.base_url = "http://127.0.0.1:18803/v1"
        settings = MagicMock()
        settings.load_error = None
        return ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(), MagicMock(),
                             MagicMock(), MagicMock(), settings)

    def test_dispatch_q_exits(self):
        self.assertFalse(self._app()._dispatch("q"))

    def test_dispatch_help_returns_true(self):
        self.assertTrue(self._app()._dispatch("?"))

    def test_dispatch_invalid_choice_reports_and_continues(self):
        app = self._app()
        self.assertTrue(app._dispatch("zz"))
        self.assertIn("Scelta non valida", app.ui._body_text)

    def test_dispatch_action_sets_and_clears_hint(self):
        app = self._app()
        called = []
        app.actions["1"] = lambda: called.append(True)
        self.assertTrue(app._dispatch("1"))
        self.assertEqual(called, [True])
        self.assertEqual(app.ui._hint, "")
        self.assertTrue(app.ui._clickables)  # voci del menu ripristinate

    def test_dispatch_action_exception_is_reported(self):
        app = self._app()

        def boom():
            raise RuntimeError("errore di prova")

        app.actions["1"] = boom
        self.assertTrue(app._dispatch("1"))
        self.assertIn("errore di prova", app.ui._body_text)

    def test_dispatch_restores_menu_slash_commands_after_action(self):
        app = self._app()
        app.actions["1"] = lambda: None
        self.assertTrue(app._dispatch("1"))
        self.assertEqual(app.ui.slash_commands, MENU_SLASH)


if __name__ == "__main__":
    unittest.main()
