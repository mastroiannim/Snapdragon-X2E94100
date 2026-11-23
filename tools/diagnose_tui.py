"""Diagnosi headless della full-screen app con pipe input e dummy output."""
import sys
import threading
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, ".")

from prompt_toolkit.input.defaults import create_pipe_input
from prompt_toolkit.output import DummyOutput

import hexagon_control.ui.components as comp

pipe = create_pipe_input().__enter__()

_real_application = comp.Application


def _factory(*args, **kwargs):
    kwargs["input"] = pipe
    kwargs["output"] = DummyOutput()
    return _real_application(*args, **kwargs)


comp.Application = _factory

ui = comp.Interface()
ui.set_clickables([("4 Kilo Code", "4")])
ui_thread = threading.Thread(target=ui.start, daemon=True)
ui_thread.start()

ui.wait_ready(10)
print("1) app avviata:", ui.running, "loop:", ui._loop is not None, "app:", ui._app is not None)

ui.replace_body(__import__("rich.panel", fromlist=["Panel"]).Panel("CONTENUTO DASHBOARD\n1 Router\n4 Kilo Code", title="T"))
time.sleep(0.5)
print("2) body_text:", repr(ui._body_text[:60]))
print("3) buffer document:", repr(ui._body_buffer.document.text[:60]) if ui._body_buffer else "NO BUFFER")
print("4) click_lines:", ui._click_lines)

result = {}


def ask():
    try:
        result["v"] = ui.prompt("hexagon ›", single_key=True)
    except Exception as exc:  # noqa: BLE001
        result["err"] = exc


t = threading.Thread(target=ask, daemon=True)
t.start()
time.sleep(0.5)
print("5) pending durante prompt:", ui._pending is not None, "question:", repr(ui._question))

pipe.send_text("4")
t.join(3)
print("6) risultato prompt:", result)

# dump visuale dello screen
from prompt_toolkit.application.current import set_app
from prompt_toolkit.layout.containers import WritePosition
from prompt_toolkit.layout.screen import Screen
from prompt_toolkit.layout.mouse_handlers import MouseHandlers

app = ui._app
if app is not None:
    with set_app(app):
        screen = Screen()
        app.layout.container.write_to_screen(
            screen, MouseHandlers(), WritePosition(0, 0, 100, 30), "default", erase_bg=False, z_index=None
        )
        print("7) ---- RENDER ----")
        for y in range(30):
            row = "".join(screen.data_buffer[y][x].char for x in range(100))
            if row.strip():
                print("|" + row.rstrip())
        print("---- FINE ----")

ui.stop()
ui_thread.join(timeout=5)
print("8) stop ok, running:", ui.running)
