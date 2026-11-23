"""Test di regressione per le performance e l'architettura di rendering della TUI.

Fotografano i bug noti PRIMA del rifacimento (FASE 0): sono marcati
``expectedFailure`` e devono diventare verdi man mano che le fasi li correggono.
Quando un test passa, il decoratore va rimosso.

Bug coperti:
- I/O bloccante (HTTP) dentro il callback della toolbar di stato.
- replace_body() non atomico: due set_document (clear + append) a ogni frame.
- server_processes(): due subprocess PowerShell invece di una sola query CIM.
"""
import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from rich.panel import Panel

import hexagon_control.ui.components as components
from hexagon_control.processes import ProcessController
from hexagon_control.ui.app import ControlCenter
from hexagon_control.ui.components import Interface


def _center_with_guarded_health(ui):
    """ControlCenter il cui health() registra se viene chiamato durante il render."""
    calls = []

    processes = MagicMock()
    processes.base_url = "http://127.0.0.1:18803/v1"

    def health():
        calls.append(getattr(ui, "_in_render", False))
        return False, 0.0, []

    processes.health = health
    settings = MagicMock()
    settings.load_error = None
    center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                           MagicMock(), MagicMock(), MagicMock(), settings)
    return center, calls


class BlockingIoInRenderTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_status_provider_never_calls_health_during_render(self):
        ui = Interface()
        center, calls = _center_with_guarded_health(ui)
        ui._top_toolbar()
        self.assertTrue(calls, "il provider non e' stato consultato")
        self.assertNotIn(True, calls,
                         "health() eseguita dentro un callback di layout: redraw bloccante")


class ReplaceBodyAtomicityTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_replace_body_sets_document_exactly_once(self):
        ui = Interface()
        sets = []
        real_set_document = components.Buffer.set_document

        def spy(instance, *args, **kwargs):
            sets.append(1)
            return real_set_document(instance, *args, **kwargs)

        with patch.object(components.Buffer, "set_document", spy):
            ui.replace_body(Panel("nuovo contenuto"))
        self.assertIn("nuovo contenuto", ui._body_text)
        self.assertEqual(len(sets), 1,
                         f"replace_body non atomico: {len(sets)} aggiornamenti del documento")


class ServerProcessesQueryTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_server_processes_uses_a_single_cim_query_with_working_set(self):
        stack = MagicMock()
        stack.managed_server_pids.return_value = {7}
        settings = MagicMock()
        processes = ProcessController(Path.cwd(), stack, settings,
                                      "http://127.0.0.1:18803/v1")
        payload = ('[{"ProcessId": 7, "ExecutablePath": "C:/llama-server.exe", '
                   '"CommandLine": "llama-server", "CreationDate": "20260101"}]')
        with patch("hexagon_control.processes.sys.platform", "win32"), \
             patch("hexagon_control.processes.subprocess.run",
                   return_value=subprocess.CompletedProcess([], 0, stdout=payload, stderr="")) as run:
            result = processes.server_processes(managed_only=True)
        self.assertEqual(len(result), 1)
        self.assertEqual(run.call_count, 1,
                         "server_processes deve usare una sola query Win32_Process")
        script = run.call_args.args[0][-1]
        self.assertIn("WorkingSetSize", script,
                      "la memoria deve arrivare dalla stessa query CIM")


if __name__ == "__main__":
    unittest.main()
