"""Input values for a computable question (prototype of the verify worker's step, SPEC §3A.3.1 "Input values").
stdin: {"inputs": [...], "constraint": str, "answerProgram": str, "type": str, "quotes": [str], "chunk": str,
        "used": [str], "usedSource": [str], "seed": int}
stdout: {"ok": bool, "error"?: str, "preamble": str, "latex": {name: str}, "key": str, "target"?: bool, "hitTarget"?: bool}
The preamble defines each input as a SymPy value; it is prepended to answerProgram, the mistake programs and constraint."""
import json, random, re, sys
import sympy as sp

TEXTBOOK = {(1, 2), (3, 4), (1, 2, 3), (4, 5, 6), (2, 1), (4, 3)}
LO, HI = -9, 9
NUM = r"-?\d+(?:\.\d+)?(?:/\d+)?"

def norm(s): return re.sub(r"\s+", "", s.replace("−", "-").replace("–", "-"))

def numbers(s): return [sp.Rational(x) for x in re.findall(NUM, norm(s))]

def in_quotes(text, quotes):
    """The value's number sequence must appear in a quote, ignoring spacing and bracket style."""
    seq = ",".join(str(n) for n in numbers(text))
    for q in quotes:
        qs = ",".join(str(n) for n in numbers(q))
        if seq and ("," + seq + ",") in ("," + qs + ","): return True
    return False

def from_source(inp):
    ns = numbers(inp.get("sourceText", ""))
    if not ns: raise ValueError(f"{inp['name']}: no numbers in sourceText")
    k = inp["kind"]
    if k in ("integer", "rational"):
        if len(ns) != 1: raise ValueError(f"{inp['name']}: expected one number, got {len(ns)}")
        return ns[0]
    if k == "vector": return sp.Matrix(ns)
    size = inp.get("size") or []
    m = size[0] if size else int(len(ns) ** 0.5); n = size[1] if len(size) > 1 else m
    if not m or m * n != len(ns): raise ValueError(f"{inp['name']}: matrix size doesn't match {len(ns)} numbers")
    return sp.Matrix(m, n, ns)

def sample(inp, n_vec, rng):
    k, size = inp["kind"], inp.get("size") or []
    if k == "integer": return sp.Integer(rng.choice([v for v in range(LO, HI + 1) if v != 0]))
    if k == "rational": return sp.Rational(rng.randint(LO, HI) or 1, rng.randint(2, 9))
    if k == "vector":
        n = size[0] if size else n_vec
        while True:
            v = [rng.randint(LO, HI) for _ in range(n)]
            if min(v) < 0 and v.count(0) <= 1 and len(set(v)) > 1 and tuple(v) not in TEXTBOOK: return sp.Matrix(v)
    m = size[0] if size else rng.randint(2, 3); c = size[1] if len(size) > 1 else m
    return sp.Matrix(m, c, lambda i, j: rng.randint(LO, HI))

TUPLE = r"[\[\(]\s*" + NUM + r"(?:\s*,\s*" + NUM + r")+\s*[\]\)]"
def chunk_vectors(chunk):
    """Vectors written out in the source text, e.g. "x = (1, -2, 2)": candidates for vector inputs, in order of appearance."""
    out = []
    for m in re.findall(TUPLE, chunk.replace("−", "-")):
        v = tuple(numbers(m))
        if v not in out: out.append(v)
    return out

def pre(vals):
    lines = ["from sympy import Matrix, Integer, Rational"]
    for k, v in vals.items():
        if isinstance(v, sp.MatrixBase): lines.append(f"{k} = Matrix({v.tolist()})")
        elif v.is_integer: lines.append(f"{k} = Integer({int(v)})")
        else: lines.append(f"{k} = Rational({v.p}, {v.q})")
    return "\n".join(lines) + "\n"

def run(src, vals, var):
    g = {}; exec(compile(pre(vals) + src, "<program>", "exec"), g); return g.get(var)

def key(vals): return json.dumps({k: str(v.tolist() if isinstance(v, sp.MatrixBase) else v) for k, v in sorted(vals.items())})

def tex(v):
    if isinstance(v, sp.MatrixBase) and v.cols == 1:
        return r"\begin{bmatrix}" + " & ".join(sp.latex(x) for x in v) + r"\end{bmatrix}^T"
    return sp.latex(v)

def main():
    r = json.load(sys.stdin); rng = random.Random(r["seed"]); used = set(r.get("used", []))
    ins = r["inputs"]; n_vec = rng.randint(3, 5)
    target = rng.random() < 0.5 if r["type"] == "true_false" else None
    fixed = {}
    for i in ins:
        if i["from"] == "source":
            try: fixed[i["name"]] = from_source(i)
            except ValueError as e: return out(ok=False, error=f"source value: {e}")
            if not in_quotes(i.get("sourceText", ""), r["quotes"]): return out(ok=False, error=f"{i['name']}: sourceText not in any evidence quote")
    # Values written out in the cited chunk come first: each unused vector of the right length, in order.
    cands = [c for c in chunk_vectors(r.get("chunk", "")) if str(c) not in set(r.get("usedSource", []))]
    from_chunk = {}
    for i in ins:
        if i["from"] == "source" or i["kind"] != "vector": continue
        n = (i.get("size") or [None])[0]
        lens = {len(v) for v in from_chunk.values()}
        for c in cands:
            if (n is None or len(c) == n) and (not lens or len(c) in lens) and c not in from_chunk.values():
                from_chunk[i["name"]] = c; break
    if from_chunk:
        vals = {**fixed, **{k: sp.Matrix(v) for k, v in from_chunk.items()}}
        n_vec = len(next(iter(from_chunk.values())))
        if len(vals) == len(ins):
            try: ok = not r.get("constraint", "").strip() or run(r["constraint"], vals, "valid")
            except Exception: ok = False
            if ok:
                o = dict(ok=True, preamble=pre(vals), latex={k: tex(v) for k, v in vals.items()}, key=key(vals),
                         sourceUsed=[str(v) for v in from_chunk.values()])
                if target is not None: o.update(target=None, hitTarget=None)
                return out(**o)
        # Not every input is covered, or the constraint rejects them: keep the covered ones fixed and sample the rest.
        if len(vals) < len(ins): fixed.update({k: sp.Matrix(v) for k, v in from_chunk.items()})
        else: from_chunk = {}
    last_valid, hit = None, False
    for _ in range(50 if target is None else 2000):
        vals = dict(fixed)
        for i in ins:
            if i["name"] not in fixed: vals[i["name"]] = sample(i, n_vec, rng)
        if key(vals) in used and len(fixed) < len(ins): continue
        try:
            if r.get("constraint", "").strip() and not run(r["constraint"], vals, "valid"): continue
        except Exception as e: return out(ok=False, error=f"constraint failed: {type(e).__name__}: {e}")
        last_valid = vals
        if target is None: break
        try: res = run(r["answerProgram"], vals, "result")
        except Exception: break  # the probe reports the program error itself
        if bool(res) == target: hit = True; break
        if len(fixed) == len(ins): break  # all from source: nothing to redraw
    if last_valid is None: return out(ok=False, error="constraint can't be met in 50 draws")
    o = dict(ok=True, preamble=pre(last_valid), latex={k: tex(v) for k, v in last_valid.items()}, key=key(last_valid),
             sourceUsed=[str(v) for v in from_chunk.values()])
    if target is not None: o.update(target=target, hitTarget=hit)
    out(**o)

def out(**kw): print(json.dumps(kw))

if __name__ == "__main__": main()
