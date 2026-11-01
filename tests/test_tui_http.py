"""Prova HTTP/SSE reale su loopback, senza llama-server o servizi esterni."""
import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from rich.console import Console

import tui


class HTTPTests(unittest.TestCase):
    def test_keepalive_and_history_across_two_requests(self):
        requests_seen = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests_seen.append((self.client_address, self.path, body))
                events = [
                    {'choices': [{'delta': {'reasoning_content': 'analisi', 'content': 'risposta'},
                                  'finish_reason': None}]},
                    {'choices': [{'delta': {}, 'finish_reason': 'stop'}],
                     'usage': {'completion_tokens': 17},
                     'timings': {'predicted_n': 17, 'predicted_ms': 500, 'predicted_per_second': 34.0}},
                ]
                payload = (''.join('data:' + json.dumps(event) + '\n\n' for event in events)
                           + 'data:[DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                self.wfile.flush()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as temp, patch('tui.PromptSession', return_value=None):
                app = tui.HexagonClawTUI(base_url=f'http://127.0.0.1:{server.server_port}/v1',
                                         workspace_dir=Path(temp))
                app.console = Console(file=io.StringIO(), color_system=None)
                try:
                    app.stream_chat('prima')
                    app.stream_chat('seconda')
                    self.assertEqual(len(requests_seen), 2)
                    self.assertEqual(requests_seen[0][0], requests_seen[1][0])
                    self.assertEqual(app.messages[-1], {'role': 'assistant', 'content': 'risposta'})
                    self.assertEqual((app.last_gen_tokens, app.last_gen_speed), (17, 34.0))
                    self.assertEqual(requests_seen[1][2]['messages'][2],
                                     {'role': 'assistant', 'content': 'risposta'})
                finally:
                    app.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
