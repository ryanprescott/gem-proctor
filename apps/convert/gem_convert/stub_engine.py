"""The engine the tests use, in place of Marker: its behaviour is written in the "PDF" itself.

A request body is `%PDF-1.4` followed by lines such as `%STUB:pages=3`, `%STUB:sleep=2`, `%STUB:crash`, `%STUB:empty`,
`%STUB:raise`, `%STUB:bad`, `%STUB:big=2000000`. No PDF library is involved, so the whole service can be tested with the
standard library alone.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from typing import Any

from .errors import ConvertError
from .ranges import parse_range

NAME = "stub"
VERSION = "0"


def _flag(data: bytes, name: str) -> str | None:
    match = re.search(rb"%STUB:" + name.encode() + rb"(?:=([^\r\n]*))?", data)
    return None if match is None else (match.group(1) or b"").decode()


class StubEngine:
    def load(self) -> str:
        return VERSION

    def inspect(self, pdf: bytes, options: dict[str, Any]) -> tuple[int, list[int]]:
        if _flag(pdf, "bad") is not None:
            raise ConvertError("bad_pdf", "the stub was told this PDF is damaged")
        pages = int(_flag(pdf, "pages") or 1)
        return pages, parse_range(options.get("pageRange"), pages)

    def convert(self, pdf: bytes, options: dict[str, Any], pages: list[int]) -> dict[str, Any]:
        if _flag(pdf, "child") is not None:
            # A helper process of the worker's own, as Marker has: its pid goes in the named file.
            child = subprocess.Popen(["sleep", "300"])  # noqa: S607
            with open(_flag(pdf, "child") or os.devnull, "w") as fp:
                fp.write(str(child.pid))
        if _flag(pdf, "sleep") is not None:
            time.sleep(float(_flag(pdf, "sleep") or 0))
        if _flag(pdf, "crash") is not None:
            os._exit(9)
        if _flag(pdf, "raise") is not None:
            raise RuntimeError("the stub was told to fail")
        markdown = "" if _flag(pdf, "empty") is not None else "# Stub\n\nThe stub read this. $x^T y = 0$.\n"
        if _flag(pdf, "big") is not None:
            markdown = "x" * int(_flag(pdf, "big") or 0)
        return {"markdown": markdown, "figures": int(_flag(pdf, "figures") or 0)}
