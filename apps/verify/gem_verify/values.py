"""Values: a program's result → serialized text, back again, and the one option formatter (SPEC §3A.3.1).

Runs in children only: a value's text may come from a model program, so it is only ever parsed here.
"""

from __future__ import annotations

import math
from fractions import Fraction
from typing import Any

import numpy as np
import sympy as sp
from sympy.logic.boolalg import BooleanFalse, BooleanTrue
from sympy.parsing.sympy_parser import parse_expr


class ResultTypeError(TypeError):
    """The program's result isn't one of the value kinds."""


def is_mat(v: object) -> bool:
    return isinstance(v, sp.MatrixBase)


def is_bool(v: object) -> bool:
    return isinstance(v, BooleanTrue | BooleanFalse)


def _scalar(raw: object) -> sp.Expr:
    v = to_sympy(raw)
    if is_mat(v) or is_bool(v):
        raise ResultTypeError("a vector or matrix entry must be a number or an expression")
    return v


def _from_sequence(raw: list[Any] | tuple[Any, ...]) -> sp.MatrixBase:
    if len(raw) == 0:
        raise ResultTypeError("an empty list is not a value")
    if all(isinstance(r, list | tuple | np.ndarray) for r in raw):
        rows = [[_scalar(x) for x in r] for r in raw]
        if len({len(r) for r in rows}) != 1 or len(rows[0]) == 0:
            raise ResultTypeError("matrix rows differ in length")
        return sp.Matrix(rows)
    return sp.Matrix(len(raw), 1, [_scalar(x) for x in raw])


def to_sympy(raw: object) -> Any:
    """Python, NumPy or SymPy → a canonical SymPy value. Anything else is `ResultTypeError`."""
    if isinstance(raw, np.generic):
        raw = raw.item()
    if isinstance(raw, np.ndarray):
        raw = raw.tolist()
    if isinstance(raw, bool | BooleanTrue | BooleanFalse):
        return sp.true if raw else sp.false
    if isinstance(raw, int):
        return sp.Integer(raw)
    if isinstance(raw, Fraction):
        return sp.Rational(raw.numerator, raw.denominator)
    if isinstance(raw, float):
        if not math.isfinite(raw):
            raise ResultTypeError("the result is not a finite number")
        return sp.Float(repr(raw), 17)
    if isinstance(raw, list | tuple | sp.Tuple):
        return _from_sequence(list(raw))
    if isinstance(raw, sp.MatrixBase):
        if 1 in raw.shape and raw.rows == 1 and raw.cols > 1:
            return sp.Matrix(raw.cols, 1, list(raw))
        return sp.Matrix(raw)
    if isinstance(raw, sp.Expr):
        if raw.has(sp.nan, sp.zoo, sp.oo, -sp.oo):
            raise ResultTypeError("the result is not a finite number")
        return raw
    raise ResultTypeError(f"result has unsupported type {type(raw).__name__}")


def kind_of(v: Any) -> str:
    if is_bool(v):
        return "boolean"
    if is_mat(v):
        return "vector" if v.cols == 1 else "matrix"
    if v.is_Integer:
        return "integer"
    if v.is_Rational:
        return "rational"
    if v.is_Float:
        return "decimal"
    return "expression"


def _plain(v: sp.Expr) -> str:
    """`value`'s text for one scalar."""
    if v.is_Float:
        return _float_text(v)
    return str(v)


def _float_text(v: sp.Float) -> str:
    return repr(float(v))


def latex_of(v: Any) -> str:
    if is_bool(v):
        return r"\text{True}" if v else r"\text{False}"
    if is_mat(v):
        if v.cols == 1:
            return r"\begin{bmatrix}" + " & ".join(sp.latex(x) for x in v) + r"\end{bmatrix}^T"
        rows = [" & ".join(sp.latex(v[i, j]) for j in range(v.cols)) for i in range(v.rows)]
        return r"\begin{bmatrix}" + r" \\ ".join(rows) + r"\end{bmatrix}"
    return sp.latex(v)


def format_value(v: Any) -> str:
    """The one option formatter (flow A step 5): the correct option can't stand out by its formatting."""
    if is_bool(v):
        return "True" if v else "False"
    if is_mat(v):
        return f"${latex_of(v)}$"
    if v.is_Integer:
        return str(int(v))
    if v.is_Float:
        return _float_text(v)
    if v.is_Rational:
        sign = "-" if v.p < 0 else ""
        return f"${sign}\\frac{{{abs(v.p)}}}{{{v.q}}}$"
    return f"${sp.latex(v)}$"


def _terminating(q: int) -> bool:
    for p in (2, 5):
        while q % p == 0:
            q //= p
    return q == 1


def _decimal_of(v: Any) -> tuple[str, bool] | None:
    """A decimal string for a numeric scalar, and whether it's exact."""
    if is_bool(v) or is_mat(v) or v.free_symbols:
        return None
    if v.is_Integer:
        return str(int(v)), True
    if v.is_Rational and _terminating(v.q):
        text = format(sp.N(v, 30), "f").rstrip("0").rstrip(".")
        return text, True
    if v.is_Float:
        return _float_text(v), False
    n = sp.N(v, 15)
    if not n.is_real:
        return None
    return repr(float(n)), False


def serialize(raw: object) -> dict[str, Any]:
    v = to_sympy(raw)
    out: dict[str, Any] = {"kind": kind_of(v), "latex": latex_of(v), "text": format_value(v)}
    if is_bool(v):
        out["value"] = "True" if v else "False"
    elif is_mat(v):
        if v.cols == 1:
            out["value"] = [_plain(x) for x in v]
        else:
            out["value"] = [[_plain(v[i, j]) for j in range(v.cols)] for i in range(v.rows)]
    else:
        out["value"] = _plain(v)
    decimal = _decimal_of(v)
    if decimal is not None:
        out["decimal"], out["decimalExact"] = decimal
    return out


def _scalar_text(s: str, kind: str) -> Any:
    if kind == "integer":
        return sp.Integer(s)
    if kind == "rational":
        return sp.Rational(s)
    if kind == "decimal":
        return sp.Float(s, 17)
    return plain_symbols(parse_expr(s))


def _entry(s: str) -> Any:
    try:
        return sp.Rational(s) if "." not in s and "e" not in s.lower() else sp.Float(s, 17)
    except (TypeError, ValueError):
        return plain_symbols(parse_expr(s))


def plain_symbols(v: Any) -> Any:
    """Symbols compare by name: no assumptions, no LaTeX braces (`e_{1}` is `e_1`)."""
    if not hasattr(v, "free_symbols"):
        return v
    subs = {s: sp.Symbol(s.name.replace("{", "").replace("}", "")) for s in v.free_symbols}
    return v.xreplace(subs) if subs else v


def deserialize(d: dict[str, Any]) -> Any:
    """A serialized value back to SymPy. An expression's text is parsed here, in a child, and nowhere else."""
    kind, value = d["kind"], d["value"]
    if kind == "boolean":
        return sp.true if value == "True" else sp.false
    if kind == "vector":
        return sp.Matrix(len(value), 1, [_entry(x) for x in value])
    if kind == "matrix":
        return sp.Matrix([[_entry(x) for x in row] for row in value])
    return _scalar_text(value, kind)


def input_value(d: dict[str, Any]) -> Any:
    """An input as the program sees it: `Integer`, `Rational` or `Matrix`, with vectors as columns."""
    return deserialize(d)


def exact(x: Any) -> Any:
    """A float back to exact form where one fits (7.4833… → 2√14), otherwise rounded to 3 places."""
    if is_mat(x):
        return x.applyfunc(exact)
    if not isinstance(x, sp.Float):
        return x
    e = sp.nsimplify(x, [sp.sqrt(2), sp.sqrt(3), sp.pi], tolerance=1e-10, rational=False)
    if (e.is_rational and e.q <= 100) or (e.is_algebraic and sp.nsimplify(e**2).is_rational):
        return e
    s = sp.nsimplify(x**2, tolerance=1e-10, rational=True)
    if s.is_rational and s.q <= 100:
        return sp.sqrt(s)
    return sp.Float(round(float(x), 3), 17)
