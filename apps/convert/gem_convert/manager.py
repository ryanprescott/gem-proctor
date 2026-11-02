"""The worker's keeper: one conversion at a time, a deadline from the page count, and a fresh worker after a timeout, a
crash, or every `recycle_every` conversions (docs/P2.2.md §5 "Worker lifecycle")."""

from __future__ import annotations

import contextlib
import multiprocessing
import os
import signal
import threading
import time
from multiprocessing.connection import Connection
from typing import Any

from . import worker
from .config import Config
from .errors import ConvertError


def descendants(pid: int) -> list[int]:
    """Every process below `pid`, found through /proc: Marker starts helper servers of its own, and a worker that is
    killed must not leave them running (docs/P2.2.md §5 "Worker lifecycle")."""
    parents: dict[int, int] = {}
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        try:
            with open(f"/proc/{name}/stat") as fp:
                parents[int(name)] = int(fp.read().rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
    found: list[int] = []
    queue = [pid]
    while queue:
        parent = queue.pop()
        for child, ppid in parents.items():
            if ppid == parent and child not in found:
                found.append(child)
                queue.append(child)
    return found


class Manager:
    def __init__(self, config: Config) -> None:
        self.config = config
        self._ctx = multiprocessing.get_context("spawn")
        self._run_lock = threading.Lock()
        self._state = threading.Lock()
        self._process: Any = None
        self._conn: Connection | None = None
        self._ready = threading.Event()
        self.models = "loading"
        self.engine_version = ""
        self.conversions = 0
        self.worker_starts = 0
        self.queued = 0
        self._start()

    # ── the worker's life ────────────────────────────────────────────

    def _start(self) -> None:
        parent, child = self._ctx.Pipe()
        process = self._ctx.Process(target=worker.main, args=(child, self.config), daemon=True)
        process.start()
        child.close()
        with self._state:
            self._process, self._conn = process, parent
            self._ready = threading.Event()
            self.models = "loading"
            self.conversions = 0
            self.worker_starts += 1
        threading.Thread(target=self._await_ready, args=(parent, process, self._ready), daemon=True).start()

    def _await_ready(self, conn: Connection, process: Any, ready: threading.Event) -> None:
        try:
            if conn.poll(self.config.load_seconds):
                kind, value = conn.recv()
                with self._state:
                    if self._conn is conn:
                        self.models = "ready" if kind == "ready" else "failed"
                        if kind == "ready":
                            self.engine_version = value
            else:
                with self._state:
                    if self._conn is conn:
                        self.models = "failed"
        except (EOFError, OSError):
            with self._state:
                if self._conn is conn:
                    self.models = "failed"
        finally:
            ready.set()

    def _replace(self) -> None:
        process, conn = self._process, self._conn
        if process is not None and process.is_alive():
            below = descendants(process.pid)
            process.kill()
            for pid in below:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGKILL)
        if process is not None:
            process.join(timeout=5)
        if conn is not None:
            conn.close()
        self._start()

    def stop(self) -> None:
        process, conn = self._process, self._conn
        if conn is not None:
            with contextlib.suppress(OSError):
                conn.send(("stop",))
        if process is not None:
            process.join(timeout=3)
            if process.is_alive():
                process.kill()

    # ── conversions ──────────────────────────────────────────────────

    @property
    def busy(self) -> bool:
        return self._run_lock.locked()

    def admit(self) -> None:
        """Counts a request as waiting, or refuses it: the line is only so long."""
        with self._state:
            if self.queued >= self.config.queue_max:
                raise ConvertError("busy", f"{self.queued} requests are already waiting")
            self.queued += 1

    def convert(self, path: str, options: dict[str, Any]) -> tuple[int, int, dict[str, Any]]:
        """Runs one conversion (waiting its turn): `(pages in the document, pages read, the engine's result)`."""
        with self._run_lock:
            with self._state:
                self.queued -= 1
            self._ensure_ready()
            try:
                return self._run(path, options)
            finally:
                if self.conversions >= self.config.recycle_every:
                    self._replace()

    def _ensure_ready(self) -> None:
        if self.models == "failed":
            self._replace()
        if not self._ready.wait(self.config.load_seconds + 5) or self.models != "ready":
            raise ConvertError("failed", "the models did not load")

    def _recv(self, timeout: float) -> tuple[Any, ...]:
        conn = self._conn
        assert conn is not None
        try:
            if not conn.poll(timeout):
                self._replace()
                raise ConvertError("timeout", f"no answer within {int(timeout)} seconds; the worker was replaced")
            return conn.recv()
        except (EOFError, OSError):
            self._replace()
            raise ConvertError("failed", "the converter's worker stopped; a new one is starting") from None

    def _run(self, path: str, options: dict[str, Any]) -> tuple[int, int, dict[str, Any]]:
        conn = self._conn
        assert conn is not None
        started = time.monotonic()
        conn.send(("job", path, options))
        message = self._recv(self.config.inspect_seconds)
        if message[0] == "error":
            raise ConvertError(message[1], message[2])
        _, total, count = message
        remaining = self.config.base_seconds + self.config.seconds_per_page * count - (time.monotonic() - started)
        message = self._recv(max(remaining, 1))
        with self._state:
            self.conversions += 1
        if message[0] == "error":
            raise ConvertError(message[1], message[2])
        return total, count, message[1]
