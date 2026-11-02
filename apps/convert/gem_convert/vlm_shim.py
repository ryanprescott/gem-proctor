"""A development stand-in for the API's proxy to the vision model (docs/P2.2.md §5 "One queue", built in F2).

Surya, which Marker calls, wants an OpenAI-style server that answers `/health` and reports its model without `:latest`;
Ollama does neither. This answers those two and forwards everything else, so the converter can be tried against the box
before the API's proxy exists. Set `CONVERT_VLM_UPSTREAM` to Ollama's address to start it. It does not queue.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def start(upstream: str, port: int = 8099) -> str:
    base = upstream.rstrip("/")

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, data: bytes) -> None:
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path in ("/health", "/v1/health"):
                return self._send(200, b'{"status":"ok"}')
            try:
                with urllib.request.urlopen(base + self.path, timeout=900) as r:  # noqa: S310 — the configured upstream
                    data = r.read()
                    if self.path.rstrip("/") == "/v1/models":
                        body = json.loads(data)
                        for model in body.get("data", []):
                            model["id"] = model["id"].removesuffix(":latest")
                        data = json.dumps(body).encode()
                    self._send(r.status, data)
            except (OSError, ValueError) as err:
                self._send(502, json.dumps({"error": str(err)}).encode())

        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length", 0)))
            request = urllib.request.Request(  # noqa: S310 — the configured upstream
                base + self.path, data=body, method="POST", headers={"content-type": "application/json"}
            )
            try:
                with urllib.request.urlopen(request, timeout=900) as r:  # noqa: S310
                    self._send(r.status, r.read())
            except urllib.error.HTTPError as err:
                self._send(err.code, err.read())
            except OSError as err:
                self._send(502, json.dumps({"error": str(err)}).encode())

        def log_message(self, fmt: str, *args: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    os.environ["SURYA_INFERENCE_URL"] = url
    return url
