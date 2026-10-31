"""`sample_inputs`: a computable question's input values (SPEC §3A.3.1 "Input values"; port of inputs.py).

One child per question. `constraint` and, for `true_false`, the author program run across draws in that child,
because they all belong to one question; the final author run is a fresh request.
"""

from __future__ import annotations

import json
import random
import re
from typing import Any

import sympy as sp

from . import values as V

# Well-known textbook values (and unit vectors, below) are never drawn.
TEXTBOOK = {(1, 2), (3, 4), (1, 2, 3), (4, 5, 6), (2, 1), (4, 3)}

_NUM = r"-?\d+(?:\.\d+)?(?:/\d+)?"
_TUPLE = re.compile(r"[\[(]\s*" + _NUM + r"(?:\s*,\s*" + _NUM + r")+\s*[\])]")
_MATRIX = re.compile(r"\\begin\{[bp]?matrix\}(.*?)\\end\{[bp]?matrix\}(\s*\^\s*\{?\s*T\s*\}?)?", re.S)


class SampleFailed(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s.replace("\u2212", "-").replace("\u2013", "-"))


def _numbers(s: str) -> list[sp.Rational]:
    return [sp.Rational(x) for x in re.findall(_NUM, _norm(s))]


def in_quotes(text: str, quotes: list[str]) -> bool:
    """The value's number sequence appears in a quote, ignoring spacing and bracket style."""
    seq = ",".join(str(n) for n in _numbers(text))
    if not seq:
        return False
    return any(f",{seq}," in "," + ",".join(str(n) for n in _numbers(q)) + "," for q in quotes)


def from_source(inp: dict[str, Any]) -> Any:
    ns = _numbers(inp["sourceText"])
    name, kind = inp["name"], inp["kind"]
    if not ns:
        raise SampleFailed("source_unparseable", f"{name}: no numbers in sourceText")
    if kind in ("integer", "rational"):
        if len(ns) != 1:
            raise SampleFailed("source_unparseable", f"{name}: expected one number, got {len(ns)}")
        return ns[0]
    if kind == "vector":
        return sp.Matrix(ns)
    size = inp["size"]
    rows = size[0] if size else int(len(ns) ** 0.5)
    cols = size[1] if len(size) > 1 else rows
    if rows == 0 or rows * cols != len(ns):
        raise SampleFailed("source_unparseable", f"{name}: matrix size doesn't match {len(ns)} numbers")
    return sp.Matrix(rows, cols, ns)


def _vector_ok(v: list[int]) -> bool:
    if min(v) >= 0 or v.count(0) > 1 or len(set(v)) == 1 or tuple(v) in TEXTBOOK:
        return False
    # A unit vector: one entry ±1, the rest zero. (`count(0) <= 1` rules out long ones; this covers length 2.)
    return sorted(abs(x) for x in v) != [0, 1]


def sample_vector(n: int, rng: random.Random, s: dict[str, int]) -> list[int]:
    while True:
        v = [rng.randint(s["intMin"], s["intMax"]) for _ in range(n)]
        if _vector_ok(v):
            return v


def sample_value(inp: dict[str, Any], n_vec: int, rng: random.Random, s: dict[str, int]) -> Any:
    kind, size = inp["kind"], inp["size"]
    lo, hi = s["intMin"], s["intMax"]
    if kind == "integer":
        return sp.Integer(rng.choice([v for v in range(lo, hi + 1) if v != 0]))
    if kind == "rational":
        return sp.Rational(rng.randint(lo, hi) or 1, rng.randint(2, 9))
    if kind == "vector":
        return sp.Matrix(sample_vector(size[0] if size else n_vec, rng, s))
    rows = size[0] if size else rng.randint(s["matrixMin"], s["matrixMax"])
    cols = size[1] if len(size) > 1 else rows
    return sp.Matrix(rows, cols, lambda _i, _j: rng.randint(lo, hi))


def _matrix_values(body: str, transposed: bool) -> list[list[sp.Rational]] | None:
    rows = [[c for c in re.split("&", r)] for r in re.split(r"\\\\", body) if r.strip()]
    try:
        grid = [[sp.Rational(_norm(c)) for c in r] for r in rows]
    except (TypeError, ValueError):
        return None
    if len({len(r) for r in grid}) != 1:
        return None
    return [list(col) for col in zip(*grid, strict=True)] if transposed else grid


def chunk_values(chunks: list[str]) -> list[tuple[str, tuple[Any, ...]]]:
    """Vectors and matrices written out in the cited chunks, in order of appearance, each once.

    A value is `(kind, numbers)`: for a matrix, `numbers` holds its rows.
    """
    found: list[tuple[int, str, tuple[Any, ...]]] = []
    offset = 0
    for chunk in chunks:
        text = chunk.replace("\u2212", "-")
        for m in _TUPLE.finditer(text):
            found.append((offset + m.start(), "vector", tuple(_numbers(m[0]))))
        for m in _MATRIX.finditer(text):
            grid = _matrix_values(m[1], m[2] is not None)
            if grid is None:
                continue
            if len(grid) == 1 or len(grid[0]) == 1:
                found.append((offset + m.start(), "vector", tuple(x for row in grid for x in row)))
            else:
                found.append((offset + m.start(), "matrix", tuple(tuple(r) for r in grid)))
        offset += len(text) + 1
    ordered: list[tuple[str, tuple[Any, ...]]] = []
    for _, kind, value in sorted(found, key=lambda f: f[0]):
        if (kind, value) not in ordered:
            ordered.append((kind, value))
    return ordered


def _fits(inp: dict[str, Any], kind: str, value: tuple[Any, ...], lengths: set[int]) -> bool:
    size = inp["size"]
    if inp["kind"] != kind:
        return False
    if kind == "vector":
        return (not size or len(value) == size[0]) and (not lengths or len(value) in lengths)
    rows, cols = len(value), len(value[0])
    return (not size or rows == size[0]) and (len(size) < 2 or cols == size[1])


def _to_matrix(kind: str, value: tuple[Any, ...]) -> Any:
    return sp.Matrix(value) if kind == "vector" else sp.Matrix([list(r) for r in value])


def _source_key(kind: str, value: tuple[Any, ...]) -> str:
    return f"{kind}:{value}"


def _evaluate(program: str, vals: dict[str, Any], variable: str) -> Any:
    ns: dict[str, Any] = {"Matrix": sp.Matrix, "Integer": sp.Integer, "Rational": sp.Rational, **vals}
    exec(compile(program, "<program>", "exec"), ns)  # noqa: S102 — isolation is the security (SPEC §3A.3.1)
    return ns.get(variable)


def _valid(constraint: str, vals: dict[str, Any]) -> bool:
    return not constraint.strip() or bool(_evaluate(constraint, vals, "valid"))


def value_key(vals: dict[str, Any]) -> str:
    plain = {k: str(v.tolist() if V.is_mat(v) else v) for k, v in sorted(vals.items())}
    return json.dumps(plain)


def _reply(
    vals: dict[str, Any], source_used: list[str], target: bool | None, hit: bool | None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "status": "ok",
        "inputs": {k: V.serialize(v) for k, v in vals.items()},
        "latex": {k: V.latex_of(v) for k, v in vals.items()},
        "key": value_key(vals),
        "sourceUsed": source_used,
    }
    if target is not None or hit is not None:
        out["target"], out["hitTarget"] = target, hit
    return out


def _assign_chunk_values(
    inputs: list[dict[str, Any]], req: dict[str, Any], fixed: dict[str, Any]
) -> tuple[dict[str, Any], list[str]]:
    used = set(req["usedSource"])
    candidates = [c for c in chunk_values(req["chunks"]) if _source_key(*c) not in used]
    taken: dict[str, Any] = {}
    keys: list[str] = []
    lengths: set[int] = set()
    for inp in inputs:
        if inp["name"] in fixed or inp["kind"] not in ("vector", "matrix"):
            continue
        for c in candidates:
            if _source_key(*c) in keys or not _fits(inp, c[0], c[1], lengths):
                continue
            taken[inp["name"]] = _to_matrix(*c)
            keys.append(_source_key(*c))
            if c[0] == "vector":
                lengths.add(len(c[1]))
            break
    return taken, keys


def sample_inputs(req: dict[str, Any]) -> dict[str, Any]:
    rng = random.Random(req["seed"])  # noqa: S311 — reproducibility, not secrecy
    settings, inputs = req["sampling"], req["inputs"]
    n_vec = rng.randint(settings["vectorMin"], settings["vectorMax"])
    is_tf = req["type"] == "true_false"
    target = rng.random() < 0.5 if is_tf else None

    fixed: dict[str, Any] = {}
    for inp in inputs:
        if inp["from"] == "source":
            value = from_source(inp)
            if not in_quotes(inp["sourceText"], req["quotes"]):
                raise SampleFailed(
                    "source_not_in_quote", f"{inp['name']}: sourceText not in an evidence quote"
                )
            fixed[inp["name"]] = value

    # Values written out in the cited chunk come first: each unused one of the right kind and size, in order.
    from_chunk, source_used = _assign_chunk_values(inputs, req, fixed)
    if from_chunk:
        vals = {**fixed, **from_chunk}
        lengths = [m.rows for m in from_chunk.values() if m.cols == 1]
        n_vec = lengths[0] if lengths else n_vec
        if len(vals) == len(inputs):
            try:
                ok = _valid(req["constraint"], vals)
            except Exception:
                ok = False
            if ok:
                return _reply(vals, source_used, None, None)
            from_chunk, source_used = {}, []
        else:
            fixed.update(from_chunk)

    used = set(req["used"])
    last_valid: dict[str, Any] | None = None
    hit = False
    draws = settings["targetDraws"] if is_tf else settings["constraintDraws"]
    for _ in range(draws):
        vals = dict(fixed)
        for inp in inputs:
            if inp["name"] not in fixed:
                vals[inp["name"]] = sample_value(inp, n_vec, rng, settings)
        if value_key(vals) in used and len(fixed) < len(inputs):
            continue
        try:
            if not _valid(req["constraint"], vals):
                continue
        except (OSError, MemoryError):
            raise
        except Exception as err:
            raise SampleFailed("constraint_error", f"{type(err).__name__}: {err}"[:900]) from err
        last_valid = vals
        if not is_tf:
            break
        try:
            result = _evaluate(req["answerProgram"], vals, "result")
        except (OSError, MemoryError):
            raise
        except Exception:
            break
        if bool(result) == target:
            hit = True
            break
        if len(fixed) == len(inputs):
            break  # all from source: nothing to redraw
    if last_valid is None:
        raise SampleFailed("constraint_unmet", f"no valid draw in {draws}")
    return _reply(last_valid, source_used, target, hit if is_tf else None)
