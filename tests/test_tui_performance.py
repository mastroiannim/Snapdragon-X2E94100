"""Test di regressione per le performance e l'architettura di rendering della TUI.

Fotografano i bug noti PRIMA del rifacimento (FASE 0); diventati verdi con:
- FASE 1: vietato l'I/O bloccante nel path di lettura dello stato (cache TTL);
  server_processes() con una sola query CIM.
- FASE 2: replace_body() atomico (un solo set_document + un solo invalidate).

Bug coperti:
- I/O bloccante (HTTP) dentro il callback della toolbar di stato.
- replace_body() non atomico: due set_document (clear + append) a ogni frame.
- server_processes(): due subprocess PowerShell invece di una sola query CIM.
"""
import subprocess
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

from rich.panel import Panel

import hexagon_control.ui.components as components
from hexagon_control.processes import ProcessController
from hexagon_control.ui.app import ControlCenter
from hexagon_control.ui.components import Interface


def _hung_server():
    """Server HTTP che accetta la connessione ma non risponde mai."""

    class Hung(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            time.sleep(3600)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Hung)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _forbidden_health(*args, **kwargs):
    raise AssertionError("I/O HTTP sincrono nel path di lettura dello stato")


class _FakeProcesses:
    """Stand-in di ProcessController: health() e' il fetch bloccante, vietato nel render."""

    base_url = "http://127.0.0.1:18803/v1"
    owned = {}

    def __init__(self, calls, ui):
        self._calls = calls
        self._ui = ui

    def health(self):
        self._calls.append(getattr(self._ui, "_in_render", False))
        return False, 0.0, []

    def health_snapshot(self):
        return False, 0.0, []

    def processes_snapshot(self, managed_only=False):
        return []


def _center_with_guarded_health(ui):
    """ControlCenter il cui fetch bloccante registra se viene invocato durante il render."""
    calls = []
    settings = MagicMock()
    settings.load_error = None
    center = ControlCenter(_FakeProcesses(calls, ui), MagicMock(), MagicMock(), MagicMock(),
                           MagicMock(), MagicMock(), MagicMock(), settings)
    return center, calls


class BlockingIoInRenderTests(unittest.TestCase):
    def test_status_provider_never_calls_health_during_render(self):
        ui = Interface()
        center, calls = _center_with_guarded_health(ui)
        ui.set_status_provider(center._top_status)
        ui._top_toolbar()
        center.dashboard_renderable()
        self.assertEqual(calls, [],
                         "fetch bloccante eseguita nel path di render: redraw congelato")

    def test_status_reads_never_block_with_hung_router(self):
        """Con il router appeso (health bloccante) toolbar e dashboard restano istantanee."""
        server = _hung_server()
        try:
            url = f"http://127.0.0.1:{server.server_port}/v1"
            settings = MagicMock()
            settings.load_error = None
            processes = ProcessController(Path.cwd(), MagicMock(), MagicMock(), url)
            processes.health = _forbidden_health  # qualunque I/O sincrono qui e' un bug
            center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                                   MagicMock(), MagicMock(), MagicMock(), settings)
            center.ui.set_status_provider(center._top_status)
            started = time.perf_counter()
            center.ui._top_toolbar()
            center.dashboard_renderable()
            elapsed = (time.perf_counter() - started) * 1000
            self.assertLess(elapsed, 500,
                            f"lettura di stato bloccante nel path di render: {elapsed:.0f} ms")
        finally:
            server.shutdown()
            server.server_close()


class ReplaceBodyAtomicityTests(unittest.TestCase):
    def test_replace_body_sets_document_exactly_once(self):
        from test_control_center_ui import _start_ui_in_thread

        ui = Interface()
        _start_ui_in_thread(self, ui)
        sets = []
        real_set_document = components.Buffer.set_document

        def spy(instance, *args, **kwargs):
            sets.append(1)
            return real_set_document(instance, *args, **kwargs)

        with patch.object(components.Buffer, "set_document", spy):
            ui.replace_body(Panel("nuovo contenuto"))
            deadline = time.monotonic() + 5
            while "nuovo contenuto" not in ui._body_text and time.monotonic() < deadline:
                time.sleep(0.02)
        self.assertIn("nuovo contenuto", ui._body_text)
        self.assertEqual(len(sets), 1,
                         f"replace_body non atomico: {len(sets)} aggiornamenti del documento")


class ServerProcessesQueryTests(unittest.TestCase):
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
