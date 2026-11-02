"""The parser surface alone, for `scripts/check-convert.ts --hostile` (docs/P2.2.md M7): opens a PDF and renders its
first pages with the engine's own code, no models loaded, and prints one JSON line. Run with no network."""

from __future__ import annotations

import json
import sys
import time

from .errors import ConvertError
from .marker_engine import MarkerEngine, render_page


def main(path: str) -> None:
    started = time.monotonic()
    with open(path, "rb") as fp:
        pdf = fp.read()
    engine = MarkerEngine()
    try:
        total, pages = engine.inspect(pdf, {})
        import pypdfium2 as pdfium

        document = pdfium.PdfDocument(pdf)
        try:
            rendered = [render_page(document, i, 144).size for i in pages[:3]]
        finally:
            document.close()
        result = {"status": "ok", "pages": total, "rendered": rendered}
    except ConvertError as err:
        result = {"status": "refused", "code": err.code}
    print(json.dumps({**result, "seconds": round(time.monotonic() - started, 2)}), flush=True)


if __name__ == "__main__":
    main(sys.argv[1])
