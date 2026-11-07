"""Marker as the engine (docs/P2.2.md §5). Everything heavy is imported here and only in the worker process.

`rasterize` (the default) renders each page to an image with pdfium and hands Marker an image-only PDF, so the vision
model reads the whole page, prose and equations together: on the fixtures it found every formula where Marker's own
text-layer path found some of them, out of place. `text` keeps the PDF's text layer (Marker's `balanced` mode). Pages
go in batches, so a long document never holds more than a few pages' images at once.
"""

from __future__ import annotations

import os
import re
import tempfile
from importlib.metadata import version as package_version
from typing import Any

from .errors import ConvertError
from .ranges import parse_range

NAME = "marker"
#: Pages rendered and converted together. Each is about 6 MB as an image at the default resolution.
BATCH_PAGES = 10
#: The most pixels one page may be rendered to (about 6000 by 5000). A page that declares a size of a hundred million
#: points would otherwise ask for a bitmap of terabytes; it is scaled down to fit, and no size at all is refused.
MAX_PIXELS = 30_000_000
_IMAGE_LINK = re.compile(r"!\[[^\]]*\]\([^)]*\)")
# Marker's mark at the start of each page when asked to paginate: `{N}` and 48 dashes, N its own page index.
_PAGE_MARK = re.compile(r"\n*\{(\d+)\}-{48}\n*")
OUTLINE_MAX = 5000


def split_pages(markdown: str, page_of: list[int]) -> list[dict[str, Any]]:
    """Marker's paginated Markdown as one entry per page. `page_of[i]` is the PDF page (from 0) that Marker's page
    `i` is; a page Marker wrote nothing for is there, empty, so a page read is a page stored."""
    texts: dict[int, list[str]] = {}
    parts = _PAGE_MARK.split(markdown)
    # Text before the first mark (there shouldn't be any) belongs to the first page.
    if parts[0].strip():
        texts.setdefault(0, []).append(parts[0])
    for i in range(1, len(parts), 2):
        index = int(parts[i])
        if 0 <= index < len(page_of):
            texts.setdefault(index, []).append(parts[i + 1])
    return [{"page": page_of[i] + 1, "markdown": "\n\n".join(texts.get(i, [])).strip()} for i in range(len(page_of))]


def read_outline(document: Any) -> list[dict[str, Any]]:
    """The PDF's bookmarks with the pages they open at. A damaged or looping outline gives what could be read."""
    entries: list[dict[str, Any]] = []
    try:
        for item in document.get_toc(max_depth=15):
            if len(entries) >= OUTLINE_MAX:
                break
            dest = item.get_dest()
            index = dest.get_index() if dest is not None else None
            entries.append(
                {
                    "title": " ".join((item.get_title() or "").split())[:500],
                    "level": min(int(item.level), 15),
                    "page": index + 1 if isinstance(index, int) and index >= 0 else None,
                }
            )
    except Exception:
        return entries
    return entries


def _compress(indexes: list[int]) -> str:
    """0-based page indexes to Marker's `page_range` ("0,2-4"), which counts from 0."""
    parts: list[str] = []
    start = prev = indexes[0]
    for i in [*indexes[1:], None]:
        if i is not None and i == prev + 1:
            prev = i
            continue
        parts.append(str(start) if start == prev else f"{start}-{prev}")
        if i is not None:
            start = prev = i
    return ",".join(parts)


def render_page(document: Any, index: int, dpi: int) -> Any:
    """One page as an RGB image, at `dpi` unless that passes MAX_PIXELS; `bad_pdf` for a page that can't be read."""
    import math

    import pypdfium2 as pdfium

    try:
        page = document[index]
        try:
            width, height = page.get_size()
        finally:
            page.close()
        if not (math.isfinite(width) and math.isfinite(height)) or width <= 0 or height <= 0:
            raise ConvertError("bad_pdf", f"page {index + 1} has no usable size")
        scale = min(dpi / 72, math.sqrt(MAX_PIXELS / (width * height)))
        if scale * min(width, height) < 1:
            raise ConvertError("bad_pdf", f"page {index + 1} is too large or too thin to read")
        page = document[index]
        try:
            return page.render(scale=scale).to_pil().convert("RGB")
        finally:
            page.close()
    except pdfium.PdfiumError as err:
        raise ConvertError("bad_pdf", f"page {index + 1} can't be loaded: {err}"[:300]) from None


def marker_settings(mode: str, page_range: str | None = None) -> dict[str, Any]:
    """What Marker is asked for. Page headers are kept: Marker labels a page's first line a page header and drops it,
    even when it is the rest of a sentence from the page before, or the document's title (P2.2 F4: on the fixtures
    that lost two formulas and the title). Running headers that really repeat are dropped by our own clean-up
    (packages/knowledge, clean.ts). Footers stay dropped: mostly page numbers, which our clean-up wouldn't catch."""
    settings: dict[str, Any] = {
        "output_format": "markdown",
        "mode": mode,
        "disable_image_extraction": True,
        "keep_pageheader_in_output": True,
        # Page by page, so the API stores pages and never reads a book twice (and knows each page's top and bottom).
        "paginate_output": True,
    }
    if page_range:
        settings["page_range"] = page_range
    return settings


def _result(pages: list[dict[str, Any]], outline: list[dict[str, Any]]) -> dict[str, Any]:
    markdown = "\n\n".join(p["markdown"] for p in pages if p["markdown"])
    return {
        "markdown": markdown,
        "pages": pages,
        "outline": outline,
        "figures": len(_IMAGE_LINK.findall(markdown)),
    }


class MarkerEngine:
    def __init__(self) -> None:
        self._models: Any = None
        self._dpi = int(os.environ.get("CONVERT_RASTER_DPI", "144"))

    def load(self) -> str:
        # One page at a time to the vision model: the API's queue is where fairness is decided, not here.
        os.environ.setdefault("SURYA_INFERENCE_PARALLEL", "1")
        from marker.models import create_model_dict

        self._models = create_model_dict()
        return package_version("marker-pdf")

    # ── what the worker asks ─────────────────────────────────────────

    def inspect(self, pdf: bytes, options: dict[str, Any]) -> tuple[int, list[int]]:
        import pypdfium2 as pdfium

        try:
            document = pdfium.PdfDocument(pdf)
        except pdfium.PdfiumError as err:
            raise ConvertError(
                "bad_pdf", f"the PDF can't be opened (damaged, or protected by a password): {err}"[:300]
            ) from None
        try:
            count = len(document)
        finally:
            document.close()
        if count < 1:
            raise ConvertError("bad_pdf", "the PDF has no pages")
        return count, parse_range(options.get("pageRange"), count)

    def convert(self, pdf: bytes, options: dict[str, Any], pages: list[int]) -> dict[str, Any]:
        strategy = options.get("strategy") or os.environ.get("CONVERT_STRATEGY", "rasterize")
        if strategy == "text":
            return self._text(pdf, pages)
        return self._rasterize(pdf, pages)

    # ── the two strategies ───────────────────────────────────────────

    def _converter(self, mode: str, page_range: str | None = None) -> Any:
        from marker.config.parser import ConfigParser
        from marker.converters.pdf import PdfConverter

        parser = ConfigParser(marker_settings(mode, page_range))
        return PdfConverter(
            config=parser.generate_config_dict(),
            artifact_dict=self._models,
            processor_list=parser.get_processors(),
            renderer=parser.get_renderer(),
            llm_service=None,
        )

    @staticmethod
    def _markdown(converter: Any, path: str) -> str:
        from marker.output import text_from_rendered

        text, _, _ = text_from_rendered(converter(path))
        return text

    def _text(self, pdf: bytes, pages: list[int]) -> dict[str, Any]:
        import pypdfium2 as pdfium

        converter = self._converter("balanced", _compress(pages))
        with tempfile.NamedTemporaryFile(suffix=".pdf") as fp:
            fp.write(pdf)
            fp.flush()
            markdown = self._markdown(converter, fp.name)
        # With a page range, Marker numbers pages as the PDF does.
        by_index = {p: i for i, p in enumerate(pages)}
        split = split_pages(markdown, list(range(max(pages) + 1)))
        read = [entry for entry in split if entry["page"] - 1 in by_index]
        document = pdfium.PdfDocument(pdf)
        try:
            outline = read_outline(document)
        finally:
            document.close()
        return _result(read, outline)

    def _rasterize(self, pdf: bytes, pages: list[int]) -> dict[str, Any]:
        import pypdfium2 as pdfium

        converter = self._converter("fast")
        document = pdfium.PdfDocument(pdf)
        read: list[dict[str, Any]] = []
        try:
            outline = read_outline(document)
            for start in range(0, len(pages), BATCH_PAGES):
                batch = pages[start : start + BATCH_PAGES]
                images = [render_page(document, i, self._dpi) for i in batch]
                with tempfile.NamedTemporaryFile(suffix=".pdf") as fp:
                    images[0].save(fp.name, "PDF", save_all=True, append_images=images[1:], resolution=float(self._dpi))
                    # The image PDF's page i is the batch's i-th page.
                    read.extend(split_pages(self._markdown(converter, fp.name), batch))
        finally:
            document.close()
        return _result(read, outline)
