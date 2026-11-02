"""Page ranges: "5-23", "1,4,9-12", 1-based as a reader counts them, to a sorted list of 0-based page indexes."""

from __future__ import annotations

from .errors import ConvertError


def parse_range(text: str | None, page_count: int) -> list[int]:
    """Every page when `text` is empty; `bad_range` for a page past the end, or a range that runs backwards."""
    if not text:
        return list(range(page_count))
    pages: set[int] = set()
    for part in text.split(","):
        low_text, _, high_text = part.partition("-")
        low = int(low_text)
        high = int(high_text) if high_text else low
        if low < 1 or high < low or high > page_count:
            raise ConvertError("bad_range", f"pages {part} are not in a document of {page_count} pages")
        pages.update(range(low - 1, high))
    return sorted(pages)
