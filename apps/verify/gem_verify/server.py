"""Parent process of the verify sandbox (SPEC §3A.3.1, P2.1.md §5).

Small trusted code that never runs a model program. It listens on a Unix socket in a shared volume and
speaks newline-delimited JSON, one request per connection. Each request forks one child, one at a time, so
nothing a program does can reach the next. Single-threaded, which keeps `fork` safe and health immediate.

Recycling: it exits 0 after `recycleEvery` runs, and at once after an anomaly (a child killed by a limit, a
denial, a malformed reply); Compose restarts the container with a fresh tmpfs. Without `--require-privdrop`
and not root (local tests, `bun run e2e`), children run as the same user with one warning; the escape suite
never runs like that.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# `-I` keeps the script's directory off sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import argparse
import contextlib
import json
import selectors
import signal
import socket
import stat
import struct
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

# Pre-imported before serving: every child gets a clean copy, and needs no file reads for them.
import lark
import numpy
import sympy

from gem_verify import child, contract

MAX_REQUEST_BYTES = 256 * 1024
MAX_REPLY_BYTES = 64 * 1024
# Room for what the parent adds to a child's reply.
MAX_CHILD_BYTES = MAX_REPLY_BYTES - 512
DEFAULT_SOCKET = "/run/verify/verify.sock"
READ_TIMEOUT_S = 5.0
WALL_CLOCK_S = 10.0
DEFAULT_RECYCLE_EVERY = 500
POLL_S = 0.01
PEERCRED = struct.Struct("3i")

VERSIONS = {"sympy": sympy.__version__, "numpy": numpy.__version__, "lark": lark.__version__}
SANDBOX_VERSION = f"gem-verify/2.1 sympy/{VERSIONS['sympy']} numpy/{VERSIONS['numpy']}"


def log(event: str, **fields: object) -> None:
    """One JSON line. Never a program's text."""
    print(json.dumps({"event": event, **fields}), flush=True)


def encode(reply: dict[str, object]) -> bytes:
    data = json.dumps(reply, separators=(",", ":")).encode()
    if len(data) > MAX_REPLY_BYTES:
        data = json.dumps({"ok": False, "error": "reply_too_large"}).encode()
    return data + b"\n"


def health_reply() -> dict[str, object]:
    return {
        "ok": True,
        "sympy": VERSIONS["sympy"],
        "numpy": VERSIONS["numpy"],
        "sandboxVersion": SANDBOX_VERSION,
    }


def status_reply(status: str, error_type: str, error: str) -> dict[str, Any]:
    return {"status": status, "errorType": error_type, "error": error}


@dataclass
class Job:
    conn: socket.socket
    request: dict[str, Any]
    pid: int = 0
    pipe: int = -1
    started: float = 0.0
    deadline: float = 0.0
    data: bytearray = field(default_factory=bytearray)
    eof: bool = False
    timed_out: bool = False
    overflow: bool = False
    denied: bool = False


@dataclass
class Pending:
    """A connection whose request line hasn't arrived."""

    conn: socket.socket
    deadline: float
    buf: bytearray = field(default_factory=bytearray)


class Supervisor:
    def __init__(
        self,
        require_privdrop: bool = False,
        recycle_every: int = DEFAULT_RECYCLE_EVERY,
        wall_clock_s: float = WALL_CLOCK_S,
    ) -> None:
        self.require_privdrop = require_privdrop
        self.recycle_every = recycle_every
        self.wall_clock_s = wall_clock_s
        self.sel = selectors.DefaultSelector()
        self.pending: dict[socket.socket, Pending] = {}
        self.queue: deque[Job] = deque()
        self.job: Job | None = None
        self.runs = 0
        self.recycle = False
        self.stop = False

    # ── connections ──

    def add_listener(self, server: socket.socket) -> None:
        server.setblocking(False)
        self.sel.register(server, selectors.EVENT_READ, "listener")

    def add_connection(self, conn: socket.socket) -> None:
        conn.setblocking(False)
        self.pending[conn] = Pending(conn, time.monotonic() + READ_TIMEOUT_S)
        self.sel.register(conn, selectors.EVENT_READ, "conn")

    def accept(self, server: socket.socket) -> None:
        conn, _ = server.accept()
        pid, uid, _gid = PEERCRED.unpack(
            conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, PEERCRED.size)
        )
        if uid == child.RUNNER_UID or (self.job is not None and pid == self.job.pid):
            # A child reaching for the parent: refused, and that run is a denial.
            conn.close()
            log("peer_refused", pid=pid, uid=uid)
            if self.job is not None:
                self.job.denied = True
            return
        self.add_connection(conn)

    def forget(self, conn: socket.socket) -> None:
        self.pending.pop(conn, None)
        self.sel.unregister(conn)

    def reply(self, conn: socket.socket, body: dict[str, object]) -> None:
        try:
            conn.setblocking(True)
            conn.settimeout(READ_TIMEOUT_S)
            conn.sendall(encode(body))
        except OSError:
            pass
        finally:
            conn.close()

    def read(self, conn: socket.socket) -> None:
        entry = self.pending[conn]
        try:
            chunk = conn.recv(65536)
        except BlockingIOError:
            return
        except OSError:
            chunk = b""
        if not chunk:
            self.forget(conn)
            conn.close()
            return
        entry.buf += chunk
        if len(entry.buf) > MAX_REQUEST_BYTES:
            self.forget(conn)
            self.reply(conn, {"ok": False, "error": "request_too_large"})
        elif b"\n" in entry.buf:
            line = bytes(entry.buf).split(b"\n", 1)[0]
            self.forget(conn)
            self.request(conn, line)

    def request(self, conn: socket.socket, line: bytes) -> None:
        try:
            request = json.loads(line)
        except (ValueError, RecursionError):
            self.reply(conn, {"ok": False, "error": "invalid_json"})
            return
        if not contract.valid_request(request):
            self.reply(conn, {"ok": False, "error": "unsupported_request"})
            return
        if "recycleEvery" in request:
            self.recycle_every = request["recycleEvery"]
        if request["kind"] == "health":
            self.reply(conn, health_reply())
            return
        self.queue.append(Job(conn, request))

    # ── children ──

    def start_next(self) -> None:
        if self.job is not None or not self.queue or self.recycle:
            return
        job = self.queue.popleft()
        read_end, write_end = os.pipe()
        job.started = time.monotonic()
        job.deadline = job.started + self.wall_clock_s
        job.pipe = read_end
        pid = os.fork()
        if pid == 0:
            os.close(read_end)
            child.main(job.request, write_end, self.require_privdrop)
        os.close(write_end)
        job.pid = pid
        self.job = job
        self.sel.register(read_end, selectors.EVENT_READ, "pipe")
        with contextlib.suppress(OSError):  # the child already did, or already exited
            os.setpgid(pid, pid)

    def read_pipe(self) -> None:
        job = self.job
        assert job is not None
        chunk = os.read(job.pipe, 65536)
        if not chunk:
            self.close_pipe(job)
            return
        job.data += chunk
        if len(job.data) > MAX_CHILD_BYTES:
            job.overflow = True
            self.close_pipe(job)
            self.kill(job)

    def close_pipe(self, job: Job) -> None:
        if not job.eof:
            job.eof = True
            self.sel.unregister(job.pipe)
            os.close(job.pipe)

    def kill(self, job: Job) -> None:
        """SIGKILL to the child's process group.

        The parent keeps only SETUID and SETGID, so root can't signal `runner` (that takes CAP_KILL). It
        borrows the effective uid for the call; it's single-threaded, so nothing else runs meanwhile. A child
        can't use the window: signal checks look at the target's real and saved uids, which stay 0.
        """
        dropped = os.geteuid() == 0
        try:
            if dropped:
                os.seteuid(child.RUNNER_UID)
            os.killpg(job.pid, signal.SIGKILL)
        except OSError:
            pass
        finally:
            if dropped:
                os.seteuid(0)

    def check_child(self) -> None:
        job = self.job
        if job is None:
            return
        if not job.timed_out and time.monotonic() >= job.deadline:
            job.timed_out = True
            self.kill(job)
        pid, status = os.waitpid(job.pid, os.WNOHANG)
        if pid == 0:
            return
        # Whatever is left in the pipe was written before the exit.
        while not job.eof and not job.overflow:
            self.read_pipe()
        self.close_pipe(job)
        self.finish(job, status)

    def child_reply(self, job: Job, status: int) -> tuple[dict[str, Any], bool]:
        """The reply for a finished child, and whether it was an anomaly."""
        kind = job.request["kind"]
        if job.timed_out:
            return status_reply("timeout", "Timeout", "the wall-clock limit was reached"), True
        if job.overflow:
            return status_reply("invalid_output", "OutputTooLarge", "the result is over the limit"), True
        if os.WIFSIGNALED(status):
            sig = os.WTERMSIG(status)
            if sig == signal.SIGXCPU:
                return status_reply("timeout", "Timeout", "the CPU limit was reached"), True
            return status_reply("sandbox_denial", "Killed", f"killed by signal {sig}"), True
        if os.WEXITSTATUS(status) == child.EXIT_PRIVDROP:
            return {"ok": False, "error": "privdrop_failed"}, True
        try:
            reply = json.loads(bytes(job.data))
            if not contract.valid_reply(kind, reply):
                raise ValueError("off contract")
        except (ValueError, RecursionError):
            return status_reply("invalid_output", "MalformedReply", "the reply isn't valid"), True
        return reply, reply["status"] == "sandbox_denial"

    def finish(self, job: Job, status: int) -> None:
        reply, anomaly = self.child_reply(job, status)
        if job.denied:
            reply = status_reply("sandbox_denial", "PeerRefused", "reached for the parent's socket")
            anomaly = True
        if reply.get("ok") is not False:
            reply.update(
                ok=True,
                durationMs=int((time.monotonic() - job.started) * 1000),
                sandboxVersion=SANDBOX_VERSION,
            )
        self.reply(job.conn, reply)
        self.job = None
        self.runs += 1
        if anomaly:
            log("recycle", reason=reply.get("status", "privdrop_failed"))
            self.recycle = True
        elif self.runs >= self.recycle_every:
            log("recycle", reason="run_budget", runs=self.runs)
            self.recycle = True

    # ── loop ──

    def expire_pending(self) -> None:
        now = time.monotonic()
        for entry in [p for p in self.pending.values() if now >= p.deadline]:
            self.forget(entry.conn)
            entry.conn.close()

    def step(self, timeout: float | None = None) -> None:
        wait = POLL_S if self.job is not None else 0.1
        for key, _ in self.sel.select(wait if timeout is None else timeout):
            if key.data == "listener":
                self.accept(key.fileobj)  # type: ignore[arg-type]
            elif key.data == "conn":
                self.read(key.fileobj)  # type: ignore[arg-type]
            elif key.data == "pipe" and self.job is not None and not self.job.eof:
                self.read_pipe()
        self.check_child()
        self.expire_pending()
        self.start_next()

    def serve(self) -> None:
        while not self.stop and not self.recycle:
            self.step()
        if self.job is not None:
            self.kill(self.job)
            os.waitpid(self.job.pid, 0)
        for job in self.queue:
            job.conn.close()  # the client waits for health and retries

    def run_sync(self, request: dict[str, Any]) -> dict[str, Any]:
        """One request, to the end, without a socket."""
        left, right = socket.socketpair()
        with right:
            self.add_connection(left)
            right.sendall(json.dumps(request).encode() + b"\n")
            right.shutdown(socket.SHUT_WR)
            while self.pending or self.job is not None or self.queue:
                self.step(POLL_S)
            return json.loads(right.makefile().readline())


def handle(request: object) -> dict[str, object]:
    """Answer one request directly (unit tests). Off the contract: a stable code, never prose."""
    if not contract.valid_request(request):
        return {"ok": False, "error": "unsupported_request"}
    return Supervisor().run_sync(request)  # type: ignore[arg-type]


def serve_connection(conn: socket.socket) -> None:
    supervisor = Supervisor()
    supervisor.add_connection(conn)
    while supervisor.pending or supervisor.job is not None or supervisor.queue:
        supervisor.step(POLL_S)


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


def check_privdrop(require: bool) -> None:
    """Under `--require-privdrop`, prove the drop works before serving: refuse to start otherwise."""
    if not require:
        return
    pid = os.fork()
    if pid == 0:
        child.drop_privileges(True)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    if status != 0:
        raise SystemExit("--require-privdrop: children can't become runner")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("socket", nargs="?", default=DEFAULT_SOCKET)
    parser.add_argument("--require-privdrop", action="store_true")
    parser.add_argument("--recycle-every", type=int, default=DEFAULT_RECYCLE_EVERY)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv[1:])
    os.environ.clear()
    check_privdrop(args.require_privdrop)
    server = bind(args.socket)
    supervisor = Supervisor(args.require_privdrop, args.recycle_every)
    supervisor.add_listener(server)

    def shutdown(_signum: int, _frame: object) -> None:
        supervisor.stop = True

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    log("listening", socket=args.socket, **VERSIONS)
    if not args.require_privdrop and os.geteuid() != 0:
        print("verify: running children as the current user, not for untrusted programs", file=sys.stderr)
    supervisor.serve()
    server.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
