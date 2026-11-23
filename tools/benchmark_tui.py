"""Misura le performance della TUI del Control Center (baseline FASE 0).

Riproduce headless i sintomi segnalati:
1. Blocco del redraw: _top_status chiama health() sincrona (server "appeso").
2. Dashboard lenta: dashboard_renderable() = health() + 2 subprocess PowerShell.
3. Flicker: replace_body() = clear + append (2 document set + 2 invalidate).
4. Latenza tasto -> risposta del prompt single-key.

Uso: python tools/benchmark_tui.py
"""
import io
import statistics
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rich.panel import Panel  # noqa: E402


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


def _make_center(base_url):
    from hexagon_control.processes import ProcessController
    from hexagon_control.ui.app import ControlCenter

    processes = ProcessController(Path.cwd(), MagicMock(), MagicMock(), base_url)
    settings = MagicMock()
    settings.load_error = None
    center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                           MagicMock(), MagicMock(), MagicMock(), settings)
    return center, processes


def bench_status_blocking():
    server = _hung_server()
    try:
        url = f"http://127.0.0.1:{server.server_port}/v1"
        center, _ = _make_center(url)
        samples = []
        for _ in range(3):
            started = time.perf_counter()
            center._top_status()
            samples.append((time.perf_counter() - started) * 1000)
        return samples
    finally:
        server.shutdown()
        server.server_close()


def bench_dashboard(base_url):
    center, _ = _make_center(base_url)
    started = time.perf_counter()
    with patch.object(center.processes, "server_processes", return_value=[]):
        center.dashboard_renderable()
    return (time.perf_counter() - started) * 1000


def bench_replace_body():
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    import hexagon_control.ui.components as comp

    counters = {"set_document": 0, "invalidate": 0}
    real_set_document = comp.Buffer.set_document
    real_invalidate = comp.Application.invalidate

    def counting_set_document(self, *args, **kwargs):
        counters["set_document"] += 1
        return real_set_document(self, *args, **kwargs)

    def counting_invalidate(self, *args, **kwargs):
        counters["invalidate"] += 1
        return real_invalidate(self, *args, **kwargs)

    with create_pipe_input() as pipe:
        real_application = comp.Application

        def factory(*args, **kwargs):
            kwargs["input"] = pipe
            kwargs["output"] = DummyOutput()
            return real_application(*args, **kwargs)

        ui = comp.Interface()
        with patch.object(comp, "Application", side_effect=factory, autospec=True), \
                patch.object(comp.Buffer, "set_document", counting_set_document), \
                patch.object(comp.Application, "invalidate", counting_invalidate):
            ui.start()
            try:
                deadline = time.monotonic() + 10
                while (ui._app is None or not ui.running) and time.monotonic() < deadline:
                    time.sleep(0.02)
                counters["set_document"] = 0
                counters["invalidate"] = 0
                ui.replace_body(Panel("dashboard di prova"))
                deadline = time.monotonic() + 5
                while counters["set_document"] < 2 and time.monotonic() < deadline:
                    time.sleep(0.02)
                time.sleep(0.2)  # lascia smaltire la coda del loop
                return dict(counters)
            finally:
                ui.stop()


def bench_keypress():
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    import hexagon_control.ui.components as comp

    with create_pipe_input() as pipe:
        real_application = comp.Application

        def factory(*args, **kwargs):
            kwargs["input"] = pipe
            kwargs["output"] = DummyOutput()
            return real_application(*args, **kwargs)

        ui = comp.Interface()
        with patch.object(comp, "Application", side_effect=factory, autospec=True):
            ui.start()
            try:
                deadline = time.monotonic() + 10
                while (ui._app is None or not ui.running) and time.monotonic() < deadline:
                    time.sleep(0.02)
                samples = []
                for _ in range(10):
                    outcome = {}

                    def ask():
                        try:
                            outcome["v"] = ui.prompt("menu", single_key=True)
                        except Exception as exc:  # noqa: BLE001
                            outcome["err"] = exc

                    worker = threading.Thread(target=ask, daemon=True)
                    worker.start()
                    time.sleep(0.1)  # il prompt e' attivo
                    started = time.perf_counter()
                    pipe.send_text("4")
                    worker.join(3)
                    samples.append((time.perf_counter() - started) * 1000)
                    if "v" not in outcome:
                        return {"errore": "prompt non risolto"}
                return {"p50": statistics.median(samples), "samples": [round(s, 1) for s in samples]}
            finally:
                ui.stop()


def main():
    print("== Benchmark TUI Hexagon (FASE 0 baseline) ==")

    samples = bench_status_blocking()
    print(f"1) _top_status con router appeso: {['%.0f ms' % s for s in samples]} "
          f"(massimo {max(samples):.0f} ms per redraw)")

    t = bench_dashboard("http://127.0.0.1:9/v1")  # porta chiusa: connessione rifiutata
    print(f"2) dashboard_renderable() offline: {t:.0f} ms")

    counters = bench_replace_body()
    print(f"3) replace_body(): set_document={counters['set_document']} "
          f"invalidate={counters['invalidate']} (target: 1 e 1)")

    result = bench_keypress()
    print(f"4) keypress->risposta prompt: {result}")


if __name__ == "__main__":
    main()
