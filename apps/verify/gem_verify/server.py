"""Parent process of the verify sandbox (SPEC §3A.3.1, P0.md §5 "Verify skeleton").

Listens on a Unix socket in a shared volume and speaks newline-delimited JSON, one request per
connection. P0 answers only ``{"kind": "health"}`` with the pinned library versions. Running model
programs (fork per run, rlimits, an unprivileged child) arrives in P2.1; this parent never runs one.

Standard library only, apart from pre-importing the math libraries the children will use.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import stat
import sys
import threading
from pathlib import Path

# Pre-import at startup so forked children (P2.1) don't pay the import per run.
import lark
import numpy
import sympy

MAX_REQUEST_BYTES = 64 * 1024
MAX_REPLY_BYTES = 64 * 1024
DEFAULT_SOCKET = "/run/verify/verify.sock"
READ_TIMEOUT_S = 5.0

VERSIONS = {"sympy": sympy.__version__, "numpy": numpy.__version__, "lark": lark.__version__}


def handle(request: object) -> dict[str, object]:
    """Answer one request. Unknown kinds get a stable error code, never prose."""
    if isinstance(request, dict) and request.get("kind") == "health":
        return {"ok": True, "sympy": VERSIONS["sympy"], "numpy": VERSIONS["numpy"]}
    return {"ok": False, "error": "unsupported_request"}


def encode(reply: dict[str, object]) -> bytes:
    data = json.dumps(reply, separators=(",", ":")).encode()
    if len(data) > MAX_REPLY_BYTES:
        data = json.dumps({"ok": False, "error": "reply_too_large"}).encode()
    return data + b"\n"


def serve_connection(conn: socket.socket) -> None:
    with conn:
        conn.settimeout(READ_TIMEOUT_S)
        buf = b""
        try:
            while b"\n" not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
                if len(buf) > MAX_REQUEST_BYTES:
                    conn.sendall(encode({"ok": False, "error": "request_too_large"}))
                    return
            line = buf.split(b"\n", 1)[0]
            try:
                request = json.loads(line)
            except ValueError:
                conn.sendall(encode({"ok": False, "error": "invalid_json"}))
                return
            conn.sendall(encode(handle(request)))
        except (TimeoutError, OSError):
            return


def bind(path: str) -> socket.socket:
    sock_path = Path(path)
    # The socket directory is writable only by this process's user (children can't replace it).
    sock_path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if sock_path.exists() or sock_path.is_symlink():
        mode = sock_path.lstat().st_mode
        if not stat.S_ISSOCK(mode):
            raise SystemExit(f"refusing to replace non-socket at {sock_path}")
        sock_path.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(sock_path))
    # The API's job worker connects from another container: any user may connect, only we may write the dir.
    os.chmod(sock_path, 0o666)  # noqa: S103
    server.listen(16)
    return server


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) > 1 else DEFAULT_SOCKET
    server = bind(path)
    stop = threading.Event()

    def shutdown(_signum: int, _frame: object) -> None:
        stop.set()
        server.close()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    print(json.dumps({"event": "listening", "socket": path, **VERSIONS}), flush=True)
    while not stop.is_set():
        try:
            conn, _ = server.accept()
        except OSError:
            break
        threading.Thread(target=serve_connection, args=(conn,), daemon=True).start()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
