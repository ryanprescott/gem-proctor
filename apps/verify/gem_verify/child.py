"""One forked child: drop everything, do one thing, write one JSON reply, exit (SPEC §3A.3.1).

The child installs nothing to block access. Isolation stops a program; what happened is only
classified afterwards.
"""

from __future__ import annotations

import errno
import gc
import json
import os
import resource
import socket
import sys
from typing import Any, NoReturn

import sympy as sp

from . import compare, options, parsing, sampling
from . import values as V

RUNNER_UID = 10002
RESULT_FD = 3
MAX_ERROR_CHARS = 500
EXIT_PRIVDROP = 70

CPU_S = 5
ADDRESS_SPACE = 512 * 1024 * 1024
OPEN_FILES = 16

# What a blocked attempt looks like (P2.1.md §5). Ordinary math errors are never in here.
_DENIED_ERRNOS = {
    errno.EACCES,
    errno.EPERM,
    errno.ENETUNREACH,
    errno.EHOSTUNREACH,
    errno.EAFNOSUPPORT,
    errno.ECONNREFUSED,
    errno.EROFS,
    errno.EFBIG,
    errno.EMFILE,
    errno.EAGAIN,
}


class _Sink:
    """`print` in a program goes nowhere: fds 0 to 2 are closed."""

    def write(self, text: str) -> int:
        return len(text)

    def flush(self) -> None:
        pass


def drop_privileges(require: bool) -> None:
    """Become `runner`. As root this also clears every capability. Fails closed under `--require-privdrop`."""
    if os.geteuid() == 0:
        try:
            os.setgroups([])
            os.setgid(RUNNER_UID)
            os.setuid(RUNNER_UID)
        except OSError:
            if require:
                os._exit(EXIT_PRIVDROP)
    if require and (os.getuid() != RUNNER_UID or os.geteuid() != RUNNER_UID):
        os._exit(EXIT_PRIVDROP)


def set_limits() -> None:
    limits = [
        (resource.RLIMIT_CPU, (CPU_S, CPU_S + 1)),  # SIGXCPU at the soft limit, SIGKILL at the hard one
        (resource.RLIMIT_AS, (ADDRESS_SPACE, ADDRESS_SPACE)),
        (resource.RLIMIT_FSIZE, (0, 0)),
        (resource.RLIMIT_NPROC, (0, 0)),
        (resource.RLIMIT_NOFILE, (OPEN_FILES, OPEN_FILES)),
        (resource.RLIMIT_CORE, (0, 0)),
    ]
    for which, value in limits:
        resource.setrlimit(which, value)


def close_inherited(result_fd: int) -> None:
    """Keep only the result pipe, on a fixed number, with no inherited stdio."""
    if result_fd != RESULT_FD:
        os.dup2(result_fd, RESULT_FD, inheritable=False)
    os.closerange(0, RESULT_FD)
    os.closerange(RESULT_FD + 1, 65536)
    sink = _Sink()
    sys.stdin = sink  # type: ignore[assignment]
    sys.stdout = sink  # type: ignore[assignment]
    sys.stderr = sink  # type: ignore[assignment]


def _describe(err: BaseException) -> tuple[str, str]:
    name = type(err).__name__
    try:
        message = str(err)
    except BaseException:
        message = ""
    if isinstance(err, SyntaxError) and err.lineno is not None:
        message = f"{err.msg} (line {err.lineno})"
    return name, f"{name}: {message}"[:MAX_ERROR_CHARS]


def is_denial(err: BaseException | None) -> bool:
    seen = 0
    while err is not None and seen < 8:
        if isinstance(err, MemoryError | BlockingIOError | socket.gaierror):
            return True
        if isinstance(err, OSError) and err.errno in _DENIED_ERRNOS:
            return True
        err = err.__cause__ or err.__context__
        seen += 1
    return False


def failure(err: BaseException) -> dict[str, Any]:
    name, message = _describe(err)
    status = "sandbox_denial" if is_denial(err) else "program_error"
    return {"status": status, "errorType": name, "error": message}


def run_program(req: dict[str, Any]) -> dict[str, Any]:
    ns: dict[str, Any] = {
        "__name__": "__main__",
        "Matrix": sp.Matrix,
        "Integer": sp.Integer,
        "Rational": sp.Rational,
    }
    ns.update({k: V.input_value(v) for k, v in req.get("inputs", {}).items()})
    variable = req.get("variable", "result")
    exec(compile(req["program"], "<program>", "exec"), ns)  # noqa: S102 — isolation is the security (SPEC §3A.3.1)
    if variable not in ns:
        raise NameError(f"the program did not set `{variable}`")
    if variable == "valid":
        return {"status": "ok", "value": V.serialize(bool(ns[variable]))}
    try:
        return {"status": "ok", "value": V.serialize(ns[variable])}
    except V.ResultTypeError:
        raise
    except (ValueError, OverflowError, RecursionError) as err:
        return {
            "status": "invalid_output",
            "errorType": type(err).__name__,
            "error": str(err)[:MAX_ERROR_CHARS],
        }


def _sample(req: dict[str, Any]) -> dict[str, Any]:
    try:
        return sampling.sample_inputs(req)
    except sampling.SampleFailed as failed:
        return {"status": "ok", "failure": failed.code, "detail": failed.detail[:900]}


def dispatch(req: dict[str, Any]) -> dict[str, Any]:
    kind = req["kind"]
    if kind == "run":
        return run_program(req)
    if kind == "sample_inputs":
        return _sample(req)
    if kind == "parse_options":
        return {"status": "ok", "results": parsing.parse_options(req["texts"])}
    if kind == "compare":
        return {"status": "ok", "results": compare.compare(req["a"], req["candidates"], req["tolerance"])}
    return options.build_options(req)


def write_reply(reply: dict[str, Any]) -> None:
    data = json.dumps(reply, separators=(",", ":")).encode()
    view = memoryview(data)
    while view:
        view = view[os.write(RESULT_FD, view) :]


def main(request: dict[str, Any], result_fd: int, require_privdrop: bool) -> NoReturn:
    # Objects inherited from the parent stay uncollected: finalizing a stale socket or selector here would
    # close its fd number, which may be the result pipe's by now.
    gc.freeze()
    try:
        os.setpgid(0, 0)
        drop_privileges(require_privdrop)
        set_limits()
        os.environ.clear()
        close_inherited(result_fd)
        try:
            reply = dispatch(request)
        except BaseException as err:
            reply = failure(err)
        write_reply(reply)
    finally:
        os._exit(0)
