"""`build_options`: options of a computed single_choice answer (SPEC §3A.3.1 step 5; port of distract.py).

Sources: `common` = a mistake program's value; `near` = a generic slip applied to the answer; `random` = a
completely wrong value of the same shape and kind. No value here comes from model-written text.
"""

from __future__ import annotations

import random
from typing import Any

import sympy as sp

from . import compare as C
from . import values as V

MAX_COMMON = 2
_TOLERANCE = 1e-9


def _same(a: Any, b: Any) -> bool:
    try:
        return C.equal(a, b, _TOLERANCE)
    except (TypeError, ValueError):
        return False


def kind(v: Any) -> tuple[Any, ...]:
    if V.is_mat(v):
        return ("matrix", v.shape)
    if v.is_integer:
        return ("int",)
    if v.is_rational:
        return ("rational",)
    if v.free_symbols:
        return ("symbolic",)
    return ("real",)


def near(v: Any, rng: random.Random) -> list[tuple[str, Any]]:
    """Generic slips: sign, off by one, doubling, reciprocal, square vs root, one wrong entry, transpose."""
    out: list[tuple[str, Any]] = []
    if V.is_mat(v):
        out.append(("sign of every entry flipped", -v))
        i = rng.randrange(len(v))
        w = v.copy()
        w[i] = -w[i]
        if not _same(w, v):
            out.append(("one entry's sign flipped", w))
        i = rng.randrange(len(v))
        w = v.copy()
        w[i] = w[i] + rng.choice([-1, 1])
        out.append(("one entry off by one", w))
        if v.rows > 1 and v.cols > 1 and not _same(v.T, v):
            out.append(("transposed", v.T))
        return out
    k = kind(v)[0]
    if v != 0:
        out.append(("sign error", -v))
    if k == "int":
        out += [("off by one", v + 1), ("off by one", v - 1)]
        if v != 0:
            out.append(("doubled", 2 * v))
    elif k == "rational":
        out += [("reciprocal", 1 / v), ("off by one", v + 1)]
    elif k == "symbolic":
        out += [("off by one", v + 1), ("off by one", v - 1), ("doubled", 2 * v)]
    else:
        sq = sp.nsimplify(v**2)
        if sq.is_rational:  # e.g. a norm sqrt(38): the squared value and its neighbours' roots
            out += [("forgot the square root", sq), ("off by one under the root", sp.sqrt(sq + 1))]
            if sq > 1:
                out.append(("off by one under the root", sp.sqrt(sq - 1)))
        out.append(("doubled", 2 * v))
    return out


def random_value(v: Any, rng: random.Random) -> Any:
    """A completely wrong value of the same shape and kind, on the same scale as the answer."""
    if V.is_mat(v):
        m = int(max([abs(float(sp.N(x))) for x in v if not x.free_symbols] + [1])) + 5
        return sp.Matrix(v.rows, v.cols, lambda _i, _j: rng.randint(-m, m))
    k = kind(v)[0]
    if k == "symbolic":
        return rng.randint(2, 5) * v + rng.randint(-5, 5)
    m = int(abs(float(sp.N(v)))) * 2 + 10
    if k == "int":
        return sp.Integer(rng.randint(-m, m))
    if k == "rational":
        return sp.Rational(rng.randint(-m, m), rng.randint(2, 9))
    sq = sp.nsimplify(v**2)
    if sq.is_rational:
        top = int(sq) * 2 + 10
        return sp.sqrt(rng.choice([n for n in range(2, top) if sp.sqrt(n).is_irrational]))
    return sp.Float(round(rng.uniform(-m, m), 3), 17)


def _shape_matches(v: Any, answer: Any) -> bool:
    if V.is_mat(v) != V.is_mat(answer):
        return False
    return not V.is_mat(v) or v.shape == answer.shape


def _commons(
    mistakes: list[dict[str, Any]], answer: Any, room: int
) -> tuple[list[dict[str, Any]], list[dict[str, str]], list[Any]]:
    chosen: list[dict[str, Any]] = []
    dropped: list[dict[str, str]] = []
    taken = [answer]
    for m in mistakes:
        why = m["whyWrong"]
        try:
            v = V.exact(V.deserialize(m["value"]))
        except Exception:
            dropped.append({"whyWrong": why, "reason": "unreadable"})
            continue
        if not _shape_matches(v, answer) or V.is_bool(v):
            dropped.append({"whyWrong": why, "reason": "different shape from the answer"})
        elif any(_same(v, t) for t in taken):
            dropped.append(
                {"whyWrong": why, "reason": "equals the answer" if _same(v, answer) else "duplicate"}
            )
        elif len(chosen) < room:
            chosen.append({"value": v, "source": "common", "reason": why, "program": m["program"]})
            taken.append(v)
    return chosen, dropped, taken


def build_options(req: dict[str, Any]) -> dict[str, Any]:
    rng = random.Random(req["seed"])  # noqa: S311 — reproducibility, not secrecy
    n = req["distractorCount"]
    answer = V.exact(V.deserialize(req["answer"]))
    # Up to 2 common errors, and always room for at least one completely wrong value.
    chosen, dropped, taken = _commons(req["mistakes"], answer, min(MAX_COMMON, n - 1))

    def fresh(v: Any) -> bool:
        return (
            kind(v)[0] == kind(answer)[0]
            and _shape_matches(v, answer)
            and not any(_same(v, t) for t in taken)
        )

    def add(v: Any, source: str, reason: str) -> None:
        chosen.append({"value": v, "source": source, "reason": reason})
        taken.append(v)

    slips = near(answer, rng)
    rng.shuffle(slips)
    want_random = True
    for _ in range(200):
        if len(chosen) >= n:
            break
        if want_random or not slips:
            v = V.exact(random_value(answer, rng))
            if fresh(v):
                add(v, "random", "unrelated value")
                want_random = False
            continue
        why, v = slips.pop()
        v = V.exact(v)
        if fresh(v):
            add(v, "near", why)

    entries: list[dict[str, Any]] = [{"value": answer, "source": None, "reason": ""}, *chosen]
    rng.shuffle(entries)
    options = [{"text": V.format_value(e["value"]), "isCorrect": e["source"] is None} for e in entries]
    distractors: list[dict[str, Any]] = []
    for e in chosen:
        d = {"text": V.format_value(e["value"]), "source": e["source"], "reason": e["reason"][:400]}
        if "program" in e:
            d["program"] = e["program"]
        distractors.append(d)
    return {
        "status": "ok",
        "options": options,
        "correctAnswer": V.format_value(answer),
        "distractors": distractors,
        "dropped": [{"reason": d["reason"], "whyWrong": d["whyWrong"][:400]} for d in dropped],
    }
