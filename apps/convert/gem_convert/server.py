"""The HTTP side: `GET /health` and `POST /convert` (docs/P2.2.md §5, §6). Standard library only.

A PDF is the raw request body (`content-type: application/pdf`) and the options are JSON in `x-gem-options`. Everything
is checked before the worker sees it: size, the `%PDF-` signature, the options against the contract. The worker's reply
is checked against the contract, and capped, before it goes out.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__, contract
from .config import Config
from .errors import ConvertError
from .manager import Manager

OPTIONS_HEADER = "x-gem-options"


def make_handler(config: Config, manager: Manager) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # one line per request, to stderr
            print(f"convert: {self.address_string()} {fmt % args}", flush=True)

        def _json(self, status: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _error(self, err: ConvertError, close: bool = False) -> None:
            body = {"code": err.code, "message": err.message[:500]}
            assert contract.valid_error(body), body
            if close:
                self.close_connection = True
            self._json(err.status, body)

        def do_GET(self) -> None:
            if self.path.split("?")[0] != "/health":
                return self._error(ConvertError("bad_request", "no such route"))
            body = {
                "ok": True,
                "engine": config.engine,
                "engineVersion": manager.engine_version or "unknown",
                "models": manager.models,
                "busy": manager.busy,
                "queued": manager.queued,
                "conversions": manager.conversions,
                "workerStarts": manager.worker_starts,
                "limits": {
                    "maxBytes": config.max_bytes,
                    "maxPages": config.max_pages,
                    "baseSeconds": config.base_seconds,
                    "secondsPerPage": config.seconds_per_page,
                },
            }
            assert contract.valid_health(body), body
            self._json(200, body)

        def do_POST(self) -> None:
            if self.path.split("?")[0] != "/convert":
                return self._error(ConvertError("bad_request", "no such route"), close=True)
            try:
                options, pdf = self._read()
            except ConvertError as err:
                return self._error(err, close=True)
            os.makedirs(config.work_dir, exist_ok=True)
            fd, path = tempfile.mkstemp(suffix=".pdf", dir=config.work_dir)
            try:
                with os.fdopen(fd, "wb") as fp:
                    fp.write(pdf)
                del pdf
                try:
                    manager.admit()
                except ConvertError as err:
                    return self._error(err)
                started = time.monotonic()
                total, count, result = manager.convert(path, options)
                reply = {
                    "markdown": result["markdown"],
                    "pages": result.get("pages", []),
                    "outline": result.get("outline", []),
                    "pageCount": total,
                    "pagesConverted": count,
                    "figures": int(result.get("figures", 0)),
                    "strategy": options.get("strategy", config.default_strategy),
                    "converter": {"name": config.engine, "version": manager.engine_version or "unknown"},
                    "seconds": round(time.monotonic() - started, 2),
                }
                if not contract.valid_reply(reply):
                    raise ConvertError("failed", "the worker's reply does not match the contract")
                data = json.dumps(reply).encode()
                if len(data) > config.max_reply_bytes:
                    raise ConvertError("failed", f"the reply is {len(data)} bytes, over {config.max_reply_bytes}")
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except ConvertError as err:
                self._error(err)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(path)

        def _read(self) -> tuple[dict[str, Any], bytes]:
            raw = self.headers.get(OPTIONS_HEADER) or "{}"
            try:
                options = json.loads(raw)
            except ValueError:
                raise ConvertError("bad_request", f"{OPTIONS_HEADER} is not JSON") from None
            if not contract.valid_options(options):
                raise ConvertError("bad_request", f"{OPTIONS_HEADER} does not match the contract")
            try:
                length = int(self.headers.get("content-length", ""))
            except ValueError:
                raise ConvertError("bad_request", "a content-length is required") from None
            if length > config.max_bytes:
                raise ConvertError("too_large", f"{length} bytes is over the limit of {config.max_bytes}")
            body = self.rfile.read(length)
            if not body.startswith(b"%PDF-"):
                raise ConvertError("not_pdf", "the body does not start with %PDF-")
            return options, body

    return Handler


def serve(config: Config) -> None:
    manager = Manager(config)
    server = ThreadingHTTPServer((config.host, config.port), make_handler(config, manager))
    server.daemon_threads = True
    print(f"convert {__version__}: {config.engine} engine on {config.host}:{config.port}", flush=True)
    try:
        server.serve_forever()
    finally:
        manager.stop()
