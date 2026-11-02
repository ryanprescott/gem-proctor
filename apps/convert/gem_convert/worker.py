"""The worker process: Marker (or the stub) loaded once, and conversions run one at a time on its pipe.

Messages in: `("job", path, options)`, `("stop",)`. Messages out: `("ready", version)` or `("load_failed", text)` once;
then for a job `("pages", total, count)` and `("done", {...})` or `("error", code, message)`. The process is the unit
the manager kills and replaces, so nothing here has to survive a timeout.
"""

from __future__ import annotations

import traceback
from multiprocessing.connection import Connection
from typing import Any

from .config import Config
from .errors import ConvertError


def make_engine(name: str) -> Any:
    if name == "stub":
        from .stub_engine import StubEngine

        return StubEngine()
    if name == "marker":
        from .marker_engine import MarkerEngine

        return MarkerEngine()
    raise ValueError(f"unknown engine {name!r}")


def main(conn: Connection, config: Config) -> None:
    try:
        engine = make_engine(config.engine)
        version = engine.load()
    except Exception as err:
        conn.send(("load_failed", f"{type(err).__name__}: {err}"[:400]))
        return
    conn.send(("ready", version))
    while True:
        try:
            message = conn.recv()
        except EOFError:
            return
        if message[0] == "stop":
            return
        _, path, options = message
        try:
            with open(path, "rb") as fp:
                pdf = fp.read()
            total, pages = engine.inspect(pdf, options)
            if len(pages) > config.max_pages:
                raise ConvertError("too_many_pages", f"{len(pages)} pages is over the limit of {config.max_pages}")
            conn.send(("pages", total, len(pages)))
            result = engine.convert(pdf, options, pages)
            if not result["markdown"].strip():
                raise ConvertError("empty", "nothing readable came out of this PDF")
            conn.send(("done", result))
        except ConvertError as err:
            conn.send(("error", err.code, err.message))
        except Exception as err:
            traceback.print_exc()
            conn.send(("error", "failed", f"{type(err).__name__}: {err}"[:400]))
