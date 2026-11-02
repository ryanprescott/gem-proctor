"""Settings, from the environment (docs/P2.2.md §5). A dataclass, so a test can build one without `os.environ`."""

from __future__ import annotations

import os
from dataclasses import dataclass, replace


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return default if raw in (None, "") else int(raw)


@dataclass(frozen=True)
class Config:
    host: str = "127.0.0.1"
    port: int = 8200
    #: "marker", or "stub" for the tests (it reads its behaviour from the PDF's own bytes).
    engine: str = "marker"
    #: The largest PDF, in bytes, and the most pages one conversion reads.
    max_bytes: int = 50 * 1024 * 1024
    max_pages: int = 400
    #: A conversion's time is `base_seconds + seconds_per_page × pages`; over that the worker is killed and replaced.
    base_seconds: int = 60
    seconds_per_page: int = 40
    #: The worker opening the PDF and counting its pages gets this long before the page-based limit starts.
    inspect_seconds: int = 60
    #: How long the models may take to load before the worker counts as failed.
    load_seconds: int = 900
    #: The worker is replaced after this many conversions (a leak, or a library that degrades).
    recycle_every: int = 200
    #: Requests allowed to wait behind the one running; past it, 503 `busy`.
    queue_max: int = 8
    #: Over this a reply is `failed` and nothing is sent.
    max_reply_bytes: int = 16 * 1024 * 1024
    #: What a PDF is rendered at before the vision model reads it.
    raster_dpi: int = 144
    default_strategy: str = "rasterize"
    work_dir: str = "/tmp/gem-convert"  # noqa: S108 — a tmpfs in the container

    @staticmethod
    def from_env() -> Config:
        c = Config()
        return replace(
            c,
            host=os.environ.get("CONVERT_HOST", c.host),
            port=_int("CONVERT_PORT", c.port),
            engine=os.environ.get("CONVERT_ENGINE", c.engine),
            max_bytes=_int("CONVERT_MAX_BYTES", c.max_bytes),
            max_pages=_int("CONVERT_MAX_PAGES", c.max_pages),
            base_seconds=_int("CONVERT_BASE_SECONDS", c.base_seconds),
            seconds_per_page=_int("CONVERT_SECONDS_PER_PAGE", c.seconds_per_page),
            inspect_seconds=_int("CONVERT_INSPECT_SECONDS", c.inspect_seconds),
            load_seconds=_int("CONVERT_LOAD_SECONDS", c.load_seconds),
            recycle_every=_int("CONVERT_RECYCLE_EVERY", c.recycle_every),
            queue_max=_int("CONVERT_QUEUE_MAX", c.queue_max),
            max_reply_bytes=_int("CONVERT_MAX_REPLY_BYTES", c.max_reply_bytes),
            raster_dpi=_int("CONVERT_RASTER_DPI", c.raster_dpi),
            default_strategy=os.environ.get("CONVERT_STRATEGY", c.default_strategy),
            work_dir=os.environ.get("CONVERT_WORK_DIR", c.work_dir),
        )
