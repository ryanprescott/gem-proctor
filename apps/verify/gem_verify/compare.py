"""`compare`: are two values equal? Exact or symbolic, then a relative tolerance for floats (SPEC §3A.3.1)."""

from __future__ import annotations

import signal
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import sympy as sp

from . import values as V

GUARD_S = 2.0


class GuardExpired(BaseException):
    """The comparison took too long. A BaseException, so SymPy's `except Exception` can't swallow it."""


@contextmanager
def guard(seconds: float = GUARD_S) -> Iterator[None]:
    def fire(_signum: int, _frame: object) -> None:
        raise GuardExpired

    previous = signal.signal(signal.SIGALRM, fire)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _numeric(v: Any) -> float | None:
    try:
        return float(sp.N(v, 20))
    except (TypeError, ValueError, OverflowError):
        return None


def _scalars_equal(a: Any, b: Any, tolerance: float) -> bool:
    if a == b:
        return True
    d = a - b
    if d == 0 or sp.simplify(d) == 0:
        return True
    if not (a.has(sp.Float) or b.has(sp.Float)) or d.free_symbols:
        return False
    x, y = _numeric(a), _numeric(b)
    if x is None or y is None:
        return False
    return abs(x - y) <= max(tolerance * max(abs(x), abs(y)), 1e-12)


def equal(a: Any, b: Any, tolerance: float) -> bool:
    if V.is_bool(a) or V.is_bool(b):
        return V.is_bool(a) and V.is_bool(b) and bool(a) == bool(b)
    if V.is_mat(a) or V.is_mat(b):
        if not (V.is_mat(a) and V.is_mat(b)) or a.shape != b.shape:
            return False
        return all(_scalars_equal(x, y, tolerance) for x, y in zip(a, b, strict=True))
    return _scalars_equal(a, b, tolerance)


def compare(a: dict[str, Any], candidates: list[dict[str, Any]], tolerance: float) -> list[dict[str, bool]]:
    results: list[dict[str, bool]] = []
    for candidate in candidates:
        try:
            with guard():
                same = equal(
                    V.plain_symbols(V.deserialize(a)), V.plain_symbols(V.deserialize(candidate)), tolerance
                )
            results.append({"equal": same, "guard": False})
        except GuardExpired:
            results.append({"equal": False, "guard": True})
    return results
