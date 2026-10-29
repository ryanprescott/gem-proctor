"""Local distractors for a computed single_choice answer (prototype of the verify worker's step).
stdin: {"correct": repr, "commons": [{"repr", "whyWrong"}], "seed": int, "n": 3}
stdout: {"options": [{"text", "isCorrect", "source", "whyWrong"}], "dropped": [...]}
Sources: common = a model-written mistake program's value; near = a generic slip applied to the answer; random = a
completely wrong value of the same shape and kind. No value comes from model-written text."""
import json, random, sys
import sympy as sp

def parse(r):
    v = sp.sympify(r)
    if isinstance(v, (list, tuple)):
        v = sp.Matrix(v)
    return v.applyfunc(exact) if is_mat(v) else exact(v)

def exact(x):
    """A float from math.sqrt etc. back to exact form (7.4833... -> 2*sqrt(14)); otherwise rounded to 3 places."""
    if not isinstance(x, sp.Float): return x
    e = sp.nsimplify(x, [sp.sqrt(2), sp.sqrt(3), sp.pi], tolerance=1e-10, rational=False)
    if (e.is_rational and e.q <= 100) or (e.is_algebraic and sp.nsimplify(e ** 2).is_rational): return e
    s = sp.nsimplify(x ** 2, tolerance=1e-10, rational=True)
    if s.is_rational and s.q <= 100: return sp.sqrt(s)
    return sp.Float(round(float(x), 3))

def is_mat(v): return isinstance(v, sp.MatrixBase)

def equal(a, b):
    if is_mat(a) != is_mat(b): return False
    if is_mat(a):
        return a.shape == b.shape and all(equal(x, y) for x, y in zip(a, b))
    try:
        if sp.simplify(a - b) == 0: return True
        return abs(float(sp.N(a - b))) <= 1e-9 * max(1.0, abs(float(sp.N(a))))
    except (TypeError, ValueError):
        return False

def kind(v):
    if is_mat(v): return ("matrix", v.shape)
    if v.is_integer: return ("int",)
    if v.is_rational: return ("rational",)
    return ("real",)

def near(v, rng):
    """Generic slips: sign, off by one, doubling/halving, square vs root, one wrong entry, transpose."""
    out = []
    if is_mat(v):
        out.append(("sign of every entry flipped", -v))
        i = rng.randrange(len(v)); w = v.copy(); w[i] = -w[i]
        if not equal(w, v): out.append(("one entry's sign flipped", w))
        i = rng.randrange(len(v)); w = v.copy(); w[i] = w[i] + rng.choice([-1, 1])
        out.append(("one entry off by one", w))
        if v.rows > 1 and v.cols > 1 and not equal(v.T, v): out.append(("transposed", v.T))
        return out
    k = kind(v)[0]
    if v != 0: out.append(("sign error", -v))
    if k == "int":
        out += [("off by one", v + 1), ("off by one", v - 1)]
        if v != 0: out.append(("doubled", 2 * v))
    elif k == "rational":
        out += [("reciprocal", 1 / v), ("off by one", v + 1)]
    else:
        sq = sp.nsimplify(v ** 2)
        if sq.is_rational:  # e.g. a norm sqrt(38): the squared value and its neighbours' roots
            out += [("forgot the square root", sq), ("off by one under the root", sp.sqrt(sq + 1))]
            if sq > 1: out.append(("off by one under the root", sp.sqrt(sq - 1)))
        out.append(("doubled", 2 * v))
    return out

def random_value(v, rng):
    """A completely wrong value of the same shape and kind, on the same scale as the answer."""
    if is_mat(v):
        m = int(max([abs(float(x)) for x in v] + [1])) + 5
        return sp.Matrix(v.rows, v.cols, lambda i, j: rng.randint(-m, m))
    k = kind(v)[0]
    m = int(abs(float(sp.N(v)))) * 2 + 10
    if k == "int": return sp.Integer(rng.randint(-m, m))
    if k == "rational": return sp.Rational(rng.randint(-m, m), rng.randint(2, 9))
    sq = sp.nsimplify(v ** 2)
    if sq.is_rational:
        top = int(sq) * 2 + 10
        return sp.sqrt(rng.choice([n for n in range(2, top) if sp.sqrt(n).is_irrational]))
    return sp.Float(round(rng.uniform(-m, m), 3))

def fmt(v):
    if is_mat(v):
        if v.cols == 1:
            return r"$\begin{bmatrix}" + " & ".join(sp.latex(x) for x in v) + r"\end{bmatrix}^T$"
        rows = [" & ".join(sp.latex(v[i, j]) for j in range(v.cols)) for i in range(v.rows)]
        return r"$\begin{bmatrix}" + r" \\ ".join(rows) + r"\end{bmatrix}$"
    if v.is_integer: return str(int(v))
    if v.is_rational:
        p, q = v.p, v.q
        return ("$-" if p < 0 else "$") + rf"\frac{{{abs(p)}}}{{{q}}}$"
    return "$" + sp.latex(v) + "$"

def main():
    req = json.load(sys.stdin)
    rng = random.Random(req["seed"]); n = req.get("n", 3)
    correct = parse(req["correct"]); taken = [correct]; dropped = []
    def fresh(v):
        return kind(v)[0] == kind(correct)[0] and (not is_mat(v) or v.shape == correct.shape) \
            and not any(equal(v, t) for t in taken)
    chosen = []
    # Up to 2 common mistakes (model-written programs, values computed in the sandbox).
    for c in req["commons"]:
        try: v = parse(c["repr"])
        except Exception as e: dropped.append({"whyWrong": c["whyWrong"], "reason": f"unparseable: {e}"}); continue
        same_shape = is_mat(v) == is_mat(correct) and (not is_mat(v) or v.shape == correct.shape)
        if not same_shape: dropped.append({"whyWrong": c["whyWrong"], "reason": "different shape from the answer"}); continue
        if any(equal(v, t) for t in taken):
            dropped.append({"whyWrong": c["whyWrong"], "reason": "equals the answer" if equal(v, correct) else "duplicate"}); continue
        if len(chosen) < 2:
            chosen.append({"value": v, "source": "common", "whyWrong": c["whyWrong"]}); taken.append(v)
    # At least one completely wrong value; then generic slips; then more random values.
    pool_near = near(correct, rng); rng.shuffle(pool_near)
    want_random = 1
    for _ in range(50):
        if len(chosen) >= n: break
        if want_random:
            v = random_value(correct, rng)
            if fresh(v): chosen.append({"value": v, "source": "random", "whyWrong": "unrelated value"}); taken.append(v); want_random -= 1
            continue
        if pool_near:
            why, v = pool_near.pop()
            if fresh(v): chosen.append({"value": v, "source": "near", "whyWrong": why}); taken.append(v)
            continue
        want_random = 1
    opts = [{"text": fmt(c["value"]), "isCorrect": False, "source": c["source"], "whyWrong": c["whyWrong"]} for c in chosen]
    opts.append({"text": fmt(correct), "isCorrect": True, "source": "computed", "whyWrong": None})
    rng.shuffle(opts)
    print(json.dumps({"options": opts, "dropped": dropped}))

if __name__ == "__main__": main()
