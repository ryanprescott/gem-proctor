"""`parse_options`: option and answer texts → values; a failure is one option's, never the run's (flow B)."""

from __future__ import annotations

import re
from typing import Any

import sympy as sp
from sympy.parsing.latex.lark import LarkLaTeXParser

from . import values as V
from .compare import GuardExpired, guard

# Built once in the parent, so children need no file reads for the grammar (P2.1.md §5).
_LARK = LarkLaTeXParser()

_NUMBER = r"[+-]?(?:\d+\.?\d*|\.\d+)"
_NUM = re.compile(rf"^{_NUMBER}$")
_FRACTION = re.compile(rf"^({_NUMBER})\s*/\s*({_NUMBER})$")
_TUPLE = re.compile(r"^[\[(](.*)[\])]$", re.S)
_TRANSPOSE = re.compile(r"\s*(?:\^\s*\{?\s*(?:T|\\top|\\mathsf\{T\}|\\mathrm\{T\})\s*\}?|')\s*$")
_MATRIX = re.compile(r"^\\begin\{([bpvB]?matrix)\}(.*)\\end\{\1\}$", re.S)
_MATH = re.compile(r"\$\$(.+?)\$\$|\$(.+?)\$|\\\((.+?)\\\)|\\\[(.+?)\\\]", re.S)
_WORD = re.compile(r"[A-Za-z]{2,}")
_LATEX_NOISE = re.compile(r"\\left|\\right|\\,|\;|\\!|(?<!\\)\\ ")
_TEXT_CMD = re.compile(r"\\(?:text|mathrm|mathit|mathbf)\{([^{}]*)\}")

# More surrounding prose than this and the text isn't a value with a unit: it's a sentence.
_MAX_UNIT_WORDS = 2


class NotAValue(Exception):
    """Prose or a word such as "Undefined"."""


def _clean(text: str) -> str:
    t = text.replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-").strip()
    return t.replace(r"\dfrac", r"\frac").replace(r"\tfrac", r"\frac")


def _number(text: str) -> Any:
    return sp.Rational(text) if "." not in text else sp.Float(text, 17)


def _split_top(text: str, sep: str) -> list[str]:
    """Split on `sep` outside brackets and braces."""
    parts, depth, current = [], 0, ""
    for ch in text:
        depth += ch in "([{"
        depth -= ch in ")]}"
        if ch == sep and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    parts.append(current)
    return parts


def _matrix_env(body: str) -> Any:
    rows = [r for r in re.split(r"\\\\(?:\[[^\]]*\])?", body) if r.strip()]
    grid = [[_scalar(c) for c in r.split("&")] for r in rows]
    if len({len(r) for r in grid}) != 1:
        raise ValueError("matrix rows differ in length")
    return sp.Matrix(grid)


def _tuple(body: str) -> Any:
    parts = [p.strip() for p in _split_top(body, ",")]
    if all(_TUPLE.match(p) for p in parts):
        return sp.Matrix([[_scalar(c) for c in _split_top(p[1:-1], ",")] for p in parts])
    return sp.Matrix(len(parts), 1, [_scalar(p) for p in parts])


def _scalar(text: str) -> Any:
    t = _clean(text)
    if t == "":
        raise ValueError("empty entry")
    if _NUM.match(t):
        return _number(t)
    fraction = _FRACTION.match(t)
    if fraction:
        p, q = _number(fraction[1]), _number(fraction[2])
        if q == 0:
            raise ValueError("division by zero")
        return p / q
    expr = _LARK.doparse(t)
    if isinstance(expr, list):  # an ambiguous parse: the Lark transformer returns every reading
        raise ValueError("ambiguous expression")
    if not isinstance(expr, sp.Expr):
        raise ValueError("not an expression")
    return V.plain_symbols(expr)


def _math(text: str) -> Any:
    t = _LATEX_NOISE.sub(" ", _clean(text)).strip()
    t = _TEXT_CMD.sub(lambda m: m[1] if not _WORD.fullmatch(m[1]) else "", t).strip()
    transposed = _TRANSPOSE.search(t)
    core = t[: transposed.start()].strip() if transposed else t
    env = _MATRIX.match(core)
    if env:
        value = _matrix_env(env[2])
        return value.T if transposed and value.cols > 1 and value.rows == 1 else value
    if _TUPLE.match(core) and "," in core:
        return _tuple(core[1:-1])
    return _scalar(t)


def _strip_units(text: str) -> str:
    """A trailing word after a number or expression is a unit ("1 flop"). A bare word is prose."""
    words = text.split()
    tail = 0
    while tail < len(words) and tail < _MAX_UNIT_WORDS and _WORD.fullmatch(words[-1 - tail]):
        tail += 1
    core = " ".join(words[: len(words) - tail])
    if core == "" or _WORD.search(_LATEX_NOISE.sub(" ", re.sub(r"\\[a-zA-Z]+", " ", core))):
        raise NotAValue
    return core


def parse_text(text: str) -> Any:
    t = _clean(text)
    if t.lower() in ("true", "false"):
        return sp.true if t.lower() == "true" else sp.false
    segments = list(_MATH.finditer(t))
    if len(segments) > 1:
        raise NotAValue
    if segments:
        outside = (t[: segments[0].start()] + " " + t[segments[0].end() :]).split()
        if len(outside) > _MAX_UNIT_WORDS:
            raise NotAValue
        return _math(next(g for g in segments[0].groups() if g is not None))
    if t.startswith("\\"):
        return _math(t)
    return _math(_strip_units(t))


def parse_options(texts: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for text in texts:
        try:
            with guard():
                value = V.serialize(parse_text(text))
            results.append({"ok": True, "value": value})
        except NotAValue:
            results.append({"ok": False, "reason": "text"})
        except GuardExpired:
            results.append({"ok": False, "reason": "parse_error", "error": "guard"})
        except Exception as err:
            results.append({"ok": False, "reason": "parse_error", "error": type(err).__name__})
    return results
