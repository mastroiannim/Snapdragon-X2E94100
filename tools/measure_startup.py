"""Misura il tempo al primo frame interattivo della TUI a caldo (FASE 4).

Avvia il Control Center in headless (pipe input + DummyOutput) con un router
offline e misura il tempo dalla costruzione dell'app al primo rendering della
dashboard. Sommato al tempo di Resolve-HexagonTuiPython a caldo (cache bootstrap)
e all'overhead di processo cmd/PowerShell, stima il first frame end-to-end.

Uso: python tools/measure_startup.py
"""
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def measure_first_frame():
    from prompt_toolkit.input.defaults import create_pipe_input
    from prompt_toolkit.output import DummyOutput

    import hexagon_control.ui.components as comp
    from hexagon_control.ui.app import ControlCenter

    pipe = create_pipe_input().__enter__()
    real_application = comp.Application

    def factory(*args, **kwargs):
        kwargs["input"] = pipe
        kwargs["output"] = DummyOutput()
        return real_application(*args, **kwargs)

    processes = MagicMock()
    processes.base_url = "http://127.0.0.1:18803/v1"
    processes.health_snapshot.return_value = (False, 0.0, [])
    processes.processes_snapshot.return_value = []
    processes.owned = {}
    processes.start_status_cache = lambda: None
    processes.stop_status_cache = lambda: None
    settings = MagicMock()
    settings.load_error = None

    with patch.object(comp, "Application", side_effect=factory, autospec=True):
        center = ControlCenter(processes, MagicMock(), MagicMock(), MagicMock(),
                               MagicMock(), MagicMock(), MagicMock(), settings)
        ui = center.ui
        started = time.perf_counter()
        worker = threading.Thread(target=ui.start, daemon=True)
        worker.start()
        ui.wait_ready(10)
        # Primo frame: la dashboard renderizzata dal menu loop.
        ui.replace_body(center.dashboard_renderable())
        deadline = time.monotonic() + 5
        while "HEXAGON CONTROL CENTER" not in ui._body_text and time.monotonic() < deadline:
            time.sleep(0.005)
        # Attende che il frame sia effettivamente disegnato.
        deadline = time.monotonic() + 5
        while (ui._body_window is None or ui._body_window.render_info is None) and time.monotonic() < deadline:
            time.sleep(0.005)
        elapsed = (time.perf_counter() - started) * 1000
        ui.stop()
        worker.join(timeout=5)
    pipe.close()
    return elapsed


def main():
    samples = [measure_first_frame() for _ in range(3)]
    print("== Avvio TUI a caldo (FASE 4) ==")
    print(f"first frame headless (app build + render): {['%.0f ms' % s for s in samples]}")
    print("Nota: + Resolve-HexagonTuiPython a caldo (~240 ms con cache bootstrap)")
    print("      + overhead processo cmd/PowerShell (~300 ms) + import Python (~500 ms).")


if __name__ == "__main__":
    main()
