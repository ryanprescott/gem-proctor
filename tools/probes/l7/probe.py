"""Probe v3: prompt variants x schema variants, real sympy/numpy sandbox, one repair retry.
usage: probe.py <gen-prompt> <schema: plain|strict|strict5|strict6> <trials> [blind-prompt]"""
import ast, json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# Python with sympy + numpy (a venv); override with PROBE_PYTHON.
VENV_PY = os.environ.get("PROBE_PYTHON", os.path.join(HERE, ".venv", "bin", "python"))
BASE = os.environ.get("LLM_DEV_BASE_URL", "http://100.77.61.90:11434/v1")
MODEL = os.environ.get("LLM_DEV_MODEL", "qwen2.5-16k")
# Extra request params, e.g. PROBE_EXTRA='{"reasoning_effort": "none", "presence_penalty": 0}' for Qwen3.5 on Ollama.
EXTRA = json.loads(os.environ.get("PROBE_EXTRA", "{}"))
ALLOWED = {"sympy", "numpy", "fractions", "math", "statistics", "itertools"}
FORBIDDEN = {"open", "exec", "eval", "__import__", "getattr", "setattr", "globals", "locals", "compile", "vars", "input", "breakpoint"}
VARS = {
    "allowedImports": ", ".join(sorted(ALLOWED)),
    "resultTypeRules": "for single_choice, numeric and short_answer: a number, Fraction, list (vector), list of lists (matrix) or sympy expression; "
                       "for true_false: True or False (a bool, not a number)",
    "styleGuidance": "Test type: chapter quiz. Test individual concepts and definitions, evenly across the chapter's sections.",
}
def load(name): return open(os.path.join(HERE, "prompts", name + ".txt")).read()
def fill(t, **kw):
    for k, v in {**VARS, **kw}.items(): t = t.replace("{{" + k + "}}", v)
    assert "{{" not in t, re.findall(r"\{\{\w+\}\}", t)
    return t

CHUNK_ID = "vmls:ch1:s1.4:c1"
PASSAGE = ("The inner product of n-vectors x and y is x^T y = x_1 y_1 + x_2 y_2 + ... + x_n y_n. "
           "The norm is ||x|| = sqrt(x^T x). Two vectors are orthogonal if x^T y = 0.")
TRUTH = {"inner": -1, "norm": 13, "orth": True}
USER = (f"Source chunk [{CHUNK_ID}]:\n{PASSAGE}\n\nWrite 4 questions: 3 calculation questions "
        "(1: inner product of x=[2,4,-3] and y=[5,-2,1], single_choice with 3 options; "
        "2: norm of [3,4,12], numeric; 3: whether [1,2] and [2,-1] are orthogonal, true_false with options True/False) "
        "and 1 concept single_choice question.")

USER_OBJECTIVE = (f"Source chunk [{CHUNK_ID}]:\n{PASSAGE}\n\nObjective O1: compute inner products and norms of vectors, and decide orthogonality.\n"
        "Write 4 questions for O1: 3 calculation questions (one single_choice with 3 options, one numeric, one true_false) "
        "and 1 concept single_choice question.")
# strict6: the system builds the options, so the request no longer asks for an option count.
USER_OBJECTIVE6 = USER_OBJECTIVE.replace("one single_choice with 3 options", "one single_choice")
COPY_MARKERS = ["notebook", "pen", "store", "receipt", "[1, -2, 3]", "0.6, 0.8", "[2, -1, 2]", "transpose"]

# Field order matters: llama.cpp grammars emit properties in schema order.
EVID = {"type": "array", "items": {"type": "object", "required": ["chunkId", "quote"],
        "properties": {"chunkId": {"type": "string"}, "quote": {"type": "string"}}}}
def opt(is_correct): return {"type": "object", "required": ["text", "isCorrect"],
    "properties": {"text": {"type": "string"}, "isCorrect": is_correct, "whyWrong": {"type": "string"}}}
def question(computable, is_correct, numeric_answer=True):
    props = {"tempId": {"type": "string"}, "type": {"type": "string", "enum": ["single_choice", "numeric", "true_false"]},
             "topic": {"type": "string"}, "question": {"type": "string"}, "computable": computable,
             "answerProgram": {"type": "string"}, "options": {"type": "array", "items": opt(is_correct)}}
    if numeric_answer: props["numericAnswer"] = {"type": "number"}
    props["explanation"] = {"type": "string"}; props["evidence"] = EVID
    return {"type": "object", "properties": props,
            "required": ["tempId", "type", "topic", "question", "computable", "answerProgram", "options", "explanation", "evidence"]}
SCHEMAS = {
    "plain": question({"type": "boolean"}, {"type": "boolean"}),
    # One shallow union on `computable`: when true, the grammar can only emit isCorrect=false and no numericAnswer.
    "strict": {"anyOf": [question({"const": True}, {"const": False}, numeric_answer=False),
                         question({"const": False}, {"type": "boolean"}, numeric_answer=False)]},
}
def batch(item): return {"type": "object", "required": ["questions"], "properties": {"questions": {"type": "array", "items": item}}}
SCHEMAS = {k: batch(v) for k, v in SCHEMAS.items()}
# strict5: one branch per (computable, type); option counts and text lengths enforced by the grammar; whyWrong before text.
def s(n): return {"type": "string", "maxLength": n}
def q5(computable, qtype, options):
    props = {"tempId": s(20), "type": {"const": qtype}, "topic": s(80), "question": s(400), "computable": {"const": computable},
             "answerProgram": s(600), "options": options, "explanation": s(300), "evidence": {**EVID, "minItems": 1}}
    return {"type": "object", "properties": props, "required": list(props)}
WRONG = {"type": "object", "required": ["whyWrong", "text", "isCorrect"],
         "properties": {"whyWrong": s(160), "text": s(120), "isCorrect": {"const": False}}}
ANY = {"type": "object", "required": ["text", "isCorrect"],
       "properties": {"whyWrong": s(160), "text": s(200), "isCorrect": {"type": "boolean"}}}
TF = {"type": "object", "required": ["text", "isCorrect"], "properties": {"text": {"enum": ["True", "False"]}, "isCorrect": {"const": False}}}
SCHEMAS["strict5"] = batch({"anyOf": [
    q5(True, "single_choice", {"type": "array", "items": WRONG, "minItems": 3, "maxItems": 3}),
    q5(True, "numeric", {"type": "array", "maxItems": 0}),
    q5(True, "true_false", {"type": "array", "items": TF, "minItems": 2, "maxItems": 2}),
    q5(False, "single_choice", {"type": "array", "items": ANY, "minItems": 3, "maxItems": 4}),
]})
# strict6: the model writes no option values for computable questions; single_choice gets 2-3 mistake programs instead.
def q6(computable, qtype, options, mistakes):
    props = {"tempId": s(20), "type": {"const": qtype}, "topic": s(80), "question": s(400), "computable": {"const": computable},
             "answerProgram": s(600), "options": options, "mistakes": mistakes, "explanation": s(300), "evidence": {**EVID, "minItems": 1}}
    return {"type": "object", "properties": props, "required": list(props)}
NONE = {"type": "array", "maxItems": 0}
MISTAKE = {"type": "object", "required": ["whyWrong", "program"], "properties": {"whyWrong": s(120), "program": s(400)}}
SCHEMAS["strict6"] = batch({"anyOf": [
    q6(True, "single_choice", NONE, {"type": "array", "items": MISTAKE, "minItems": 2, "maxItems": 3}),
    q6(True, "numeric", NONE, NONE),
    q6(True, "true_false", NONE, NONE),
    q6(False, "single_choice", {"type": "array", "items": ANY, "minItems": 3, "maxItems": 4}, NONE),
]})
PROGRAM_SCHEMA = {"type": "object", "required": ["program"], "properties": {"program": {"type": "string"}}}

def chat(system, user, schema, temperature, top_p=0.8):
    body = {"model": MODEL, "temperature": temperature, "top_p": top_p, **EXTRA,
            "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "out", "strict": True, "schema": schema}}}
    req = urllib.request.Request(BASE + "/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=300) as r: d = json.load(r)
    return json.loads(d["choices"][0]["message"]["content"]), time.time() - t

def static_err(src):
    try: tree = ast.parse(src)
    except SyntaxError as e: return f"SyntaxError: {e.msg} (line {e.lineno})"
    for n in ast.walk(tree):
        if isinstance(n, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module or ""]
            bad = [m for m in mods if m.split(".")[0] not in ALLOWED]
            if bad: return f"ImportError: import of {bad} is not allowed; allowed: {', '.join(sorted(ALLOWED))}"
        if isinstance(n, ast.Name) and n.id in FORBIDDEN: return f"NameError: {n.id} is not allowed"
        if isinstance(n, ast.Attribute) and n.attr.startswith("__"): return f"AttributeError: {n.attr} is not allowed"
    return None

RUNNER = r'''
import json, sys
src = sys.stdin.read()
g = {}
exec(compile(src, "<program>", "exec"), g)
if "result" not in g: raise NameError("the program did not set `result`")
r = g["result"]
try:
    import numpy as np
    if isinstance(r, np.generic): r = r.item()
    if isinstance(r, np.ndarray): r = r.tolist()
except ImportError: pass
kind = "bool" if isinstance(r, bool) or type(r).__name__ in ("BooleanTrue", "BooleanFalse") else "value"
print(json.dumps({"kind": kind, "repr": str(r)}))
'''
def run(src):
    err = static_err(src)
    if err: return None, err
    try:
        p = subprocess.run([VENV_PY, "-I", "-c", RUNNER], input=src, capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired: return None, "TimeoutError: the program ran longer than 10 s"
    if p.returncode: return None, p.stderr.strip().splitlines()[-1]
    return json.loads(p.stdout.strip().splitlines()[-1]), None

def type_err(qtype, res):
    if qtype == "true_false" and res["kind"] != "bool": return f"TypeError: result must be True or False for a true/false question, got {res['repr']}"
    if qtype != "true_false" and res["kind"] == "bool": return f"TypeError: result must be a value, not {res['repr']}"
    return None

def run_with_repair(src, q):
    res, err = run(src)
    if res and not err: err = type_err(q["type"], res); res = None if err else res
    if not err: return res, None, False
    fixed, _ = chat(None, fill(load("repair-v1"), question=q["question"], program=src, error=err), PROGRAM_SCHEMA, 0.2)
    res2, err2 = run(fixed["program"])
    if res2 and not err2: err2 = type_err(q["type"], res2); res2 = None if err2 else res2
    return res2, (f"{err} → repaired: {err2 or 'ok'}"), True

def num(s):
    try:
        import fractions
        return float(fractions.Fraction(s.replace(" ", "")))
    except Exception:
        try: return float(s)
        except Exception: return None
def right(kind, res):
    if res is None: return False
    if kind == "orth": return res["kind"] == "bool" and res["repr"] == "True"
    n = num(res["repr"]); return n is not None and abs(n - TRUTH[kind]) < 1e-9
def which(q):
    t = q["question"].lower()
    if "[" not in t: return None
    return "orth" if "orthogonal" in t else "norm" if "norm" in t else "inner" if "inner product" in t else None
def stated(q):
    s = [o["text"] for o in q.get("options", []) if o.get("isCorrect")]
    if "numericAnswer" in q: s.append(str(q["numericAnswer"]))
    return s
def leak(q):
    allowed = set(re.findall(r"-?\d+(?:\.\d+)?", q["question"] + " " + PASSAGE)) | {"0", "1", "2"}
    return sorted(set(re.findall(r"-?\d+(?:\.\d+)?", q["explanation"])) - allowed)

def main():
    gen, schema_name, trials = sys.argv[1], sys.argv[2], int(sys.argv[3])
    blind_name = sys.argv[4] if len(sys.argv) > 4 else "blind-v2"
    if len(sys.argv) > 5 and sys.argv[5] == "objective": return objective(gen, schema_name, trials, blind_name)
    gen_sys = fill(load(gen)); schema = SCHEMAS[schema_name]
    T = dict(calc=0, flagged=0, stated=0, stated_right=0, n_stated=0, a1=0, a2=0, b1=0, b2=0, both=0, leak=0,
             concept=0, concept_ok=0, quotes=0, qs=0, in_opts=0, gen_fail=0, secs=0.0)
    log = []
    for t in range(trials):
        try: out, secs = chat(gen_sys, USER, schema, 0.7)
        except Exception as e: T["gen_fail"] += 1; print(f"trial {t+1}: generation failed: {e}"); continue
        T["secs"] += secs
        print(f"\n=== {gen}/{schema_name} trial {t+1} ({secs:.0f}s) ===")
        for q in out["questions"]:
            T["qs"] += 1
            T["quotes"] += all(e["quote"] in PASSAGE for e in q["evidence"]) and bool(q["evidence"])
            kind = which(q)
            if kind is None:
                T["concept"] += 1
                ok = (not q["computable"]) and sum(o["isCorrect"] for o in q["options"]) == 1
                T["concept_ok"] += ok
                print(f"- concept ok={ok}: {q['question'][:70]}")
                continue
            T["calc"] += 1; T["flagged"] += bool(q["computable"])
            st = stated(q); T["stated"] += bool(st)
            for s in st:
                T["n_stated"] += 1
                T["stated_right"] += (kind == "orth" and s.lower() == "true") or (kind != "orth" and num(s) is not None and abs(num(s) - TRUTH[kind]) < 1e-9)
            a, aerr, arep = run_with_repair(q["answerProgram"], q) if q["answerProgram"].strip() else (None, "no program", False)
            blind, _ = chat(None, fill(load(blind_name), passage=PASSAGE, question=q["question"]), PROGRAM_SCHEMA, 0.2)
            b, berr, brep = run_with_repair(blind["program"], q)
            ar, br = right(kind, a), right(kind, b)
            T["a2"] += ar; T["b2"] += br; T["a1"] += ar and not arep; T["b1"] += br and not brep
            T["both"] += ar and br
            lk = leak(q); T["leak"] += bool(lk)
            if kind != "orth" and any(num(o["text"]) is not None and abs(num(o["text"]) - TRUTH[kind]) < 1e-9 for o in q["options"]): T["in_opts"] += 1
            print(f"- {kind} ({q['type']}, computable={q['computable']}) stated={st} options={[o['text'] for o in q['options']]}")
            print(f"    author={a and a['repr']!r} {aerr or ''}\n    blind ={b and b['repr']!r} {berr or ''}\n    leak={lk}")
            if kind == "inner": print(f"    whyWrong={[o.get('whyWrong') for o in q['options']]}")
    c = T["calc"] or 1
    print(f"\n=== totals {gen}/{schema_name}, {trials} trials, avg gen {T['secs']/max(1,trials-T['gen_fail']):.0f}s, gen failures {T['gen_fail']} ===")
    print(f"calc {T['calc']}: flagged {T['flagged']}  STATED AN ANSWER {T['stated']}  (stated right {T['stated_right']}/{T['n_stated']})")
    print(f"author right first try {T['a1']}  after repair {T['a2']} | blind right first try {T['b1']}  after repair {T['b2']} | both right {T['both']}")
    print(f"explanation leaks {T['leak']} | true value among options {T['in_opts']} | concept ok {T['concept_ok']}/{T['concept']} | exact quotes {T['quotes']}/{T['qs']}")

def same(a, b):
    if a is None or b is None or a["kind"] != b["kind"]: return False
    if a["repr"] == b["repr"]: return True
    fa, fb = num(a["repr"]), num(b["repr"])
    if fa is not None and fb is not None: return abs(fa - fb) <= 1e-9 * max(1.0, abs(fa))
    try:
        import subprocess as sp
        code = "import sympy,sys;a,b=sympy.sympify(sys.argv[1]),sympy.sympify(sys.argv[2]);print(bool(sympy.simplify(a-b)==0) or abs(float(sympy.N(a-b)))<=1e-9*max(1.0,abs(float(sympy.N(a)))))"
        p = sp.run([VENV_PY, "-I", "-c", code, a["repr"], b["repr"]], capture_output=True, text=True, timeout=10)
        return p.stdout.strip() == "True"
    except Exception: return False

SEED = [0]
def build(q, a):
    """Local options for a computed single_choice: run the mistake programs, then distract.py. Returns (summary, stats)."""
    commons, st = [], dict(m=0, m_ran=0, kept=0, eq_answer=0, n_opts=0, src={})
    for m in q.get("mistakes", []):
        st["m"] += 1
        r, err = run(m["program"])
        if r and not err and r["kind"] == "value": st["m_ran"] += 1; commons.append({"repr": r["repr"], "whyWrong": m["whyWrong"]})
    SEED[0] += 1
    p = subprocess.run([VENV_PY, "-I", os.path.join(HERE, "distract.py")], capture_output=True, text=True, timeout=60,
                       input=json.dumps({"correct": a["repr"], "commons": commons, "seed": SEED[0]}))
    if p.returncode: return f"distract failed: {p.stderr.strip().splitlines()[-1]}", st
    d = json.loads(p.stdout)
    st["n_opts"] = len(d["options"]); st["eq_answer"] = sum(x["reason"] == "equals the answer" for x in d["dropped"])
    for o in d["options"]: st["src"][o["source"]] = st["src"].get(o["source"], 0) + 1
    st["kept"] = st["src"].get("common", 0)
    opts = [f"{o['text']}{' ✓' if o['isCorrect'] else ''} [{o['source']}: {o['whyWrong']}]" for o in d["options"]]
    return f"options={opts} dropped={d['dropped']}", st

def objective(gen, schema_name, trials, blind_name):
    gen_sys = fill(load(gen)); schema = SCHEMAS[schema_name]
    T = dict(calc=0, stated=0, agree=0, a_ok=0, b_ok=0, copied=0, leak=0, concept=0, concept_ok=0, concept_copied=0, quotes=0, qs=0,
             sc=0, m=0, m_ran=0, kept=0, eq_answer=0, four=0, nonempty_opts=0)
    SRC = {}
    for t in range(trials):
        out, secs = chat(gen_sys, USER_OBJECTIVE6 if schema_name == "strict6" else USER_OBJECTIVE, schema, 0.7)
        print(f"\n=== {gen}/{schema_name}/objective trial {t+1} ({secs:.0f}s) ===")
        for q in out["questions"]:
            T["qs"] += 1; T["quotes"] += bool(q["evidence"]) and all(e["quote"] in PASSAGE for e in q["evidence"])
            cp = [m for m in COPY_MARKERS if m in q["question"].lower() or any(m in o["text"].lower() for o in q["options"])]
            if not q["computable"]:
                T["concept"] += 1; ok = sum(o["isCorrect"] for o in q["options"]) == 1
                T["concept_ok"] += ok; T["concept_copied"] += bool(cp)
                print(f"- concept ok={ok} copied={cp}: {q['question'][:90]}")
                continue
            T["calc"] += 1; T["copied"] += bool(cp)
            st = stated(q); T["stated"] += bool(st)
            a, aerr, _ = run_with_repair(q["answerProgram"], q) if q["answerProgram"].strip() else (None, "no program", False)
            blind, _ = chat(None, fill(load(blind_name), passage=PASSAGE, question=q["question"]), PROGRAM_SCHEMA, 0.2)
            b, berr, _ = run_with_repair(blind["program"], q)
            T["a_ok"] += a is not None; T["b_ok"] += b is not None
            ag = same(a, b); T["agree"] += ag
            lk = leak(q); T["leak"] += bool(lk)
            print(f"- {q['type']} copied={cp} stated={st} agree={ag}: {q['question'][:90]}")
            print(f"    options={[o['text'] for o in q['options']]} author={a and a['repr']!r} {aerr or ''} blind={b and b['repr']!r} {berr or ''} leak={lk}")
            T["nonempty_opts"] += bool(q["options"])
            if q["type"] == "single_choice" and ag:
                summary, st = build(q, a); T["sc"] += 1
                for k in ("m", "m_ran", "kept", "eq_answer"): T[k] += st[k]
                T["four"] += st["n_opts"] == 4
                for k, v in st["src"].items(): SRC[k] = SRC.get(k, 0) + v
                print(f"    mistakes={[m['whyWrong'] for m in q.get('mistakes', [])]}\n    built {summary}")
    print(f"\n=== totals {gen}/{schema_name}/objective, {trials} trials ===")
    print(f"calc {T['calc']}: STATED {T['stated']} | author ran {T['a_ok']} blind ran {T['b_ok']} (after repair) | programs AGREE {T['agree']} | copied example {T['copied']} | leaks {T['leak']}")
    print(f"concept {T['concept']}: ok {T['concept_ok']} copied example {T['concept_copied']} | exact quotes {T['quotes']}/{T['qs']}")
    print(f"model-written option values on calc questions {T['nonempty_opts']} | single_choice built {T['sc']}: mistakes {T['m']}, ran {T['m_ran']}, "
          f"equal to the answer {T['eq_answer']}, used as common {T['kept']} | 4 options {T['four']}/{T['sc']} | option sources {SRC}")

# ── strict7 / gen-v8: named inputs (source or sampled), notation check on concept questions ──
PASSAGE7 = ("The inner product of n-vectors x and y is x^T y = x_1 y_1 + x_2 y_2 + ... + x_n y_n. "
            "The norm is ||x|| = sqrt(x^T x). Two vectors are orthogonal if x^T y = 0. "
            "For example, with x = (1, -2, 2) and y = (3, 0, -1), x^T y = 1*3 + (-2)*0 + 2*(-1) = 1, and ||x|| = sqrt(1 + 4 + 4) = 3.")
USER7 = (f"Source chunk [{CHUNK_ID}]:\n{PASSAGE7}\n\nObjective O1: compute inner products and norms of vectors, and decide orthogonality.\n"
         "Write 4 questions for O1: 3 calculation questions (one single_choice, one numeric, one true_false) and 1 concept single_choice question.")
INPUT = {"type": "object", "required": ["name", "kind", "size", "from", "sourceText"], "properties": {
    "name": {"type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9]{0,5}$"}, "kind": {"enum": ["integer", "rational", "vector", "matrix"]},
    "size": {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 6}, "maxItems": 2},
    "from": {"enum": ["source", "sample"]}, "sourceText": s(60)}}
def q7(computable, qtype, options, mistakes, inputs):
    props = {"tempId": s(20), "type": {"const": qtype}, "topic": s(80), "computable": {"const": computable},
             "evidence": {**EVID, "minItems": 1}, "inputs": inputs, "question": s(400),
             "constraint": s(200) if computable else s(0), "answerProgram": s(600) if computable else s(0),
             "options": options, "mistakes": mistakes, "explanation": s(300)}
    return {"type": "object", "properties": props, "required": list(props)}
INPUTS = {"type": "array", "items": INPUT, "minItems": 1, "maxItems": 4}
SCHEMAS["strict7"] = batch({"anyOf": [
    q7(True, "single_choice", NONE, {"type": "array", "items": MISTAKE, "minItems": 2, "maxItems": 3}, INPUTS),
    q7(True, "numeric", NONE, NONE, INPUTS),
    q7(True, "true_false", NONE, NONE, INPUTS),
    q7(False, "single_choice", {"type": "array", "items": ANY, "minItems": 3, "maxItems": 4}, NONE, NONE),
]})
CLASSIFY_SCHEMA = {"type": "object", "required": ["reason", "computable"], "properties": {"reason": s(200), "computable": {"type": "boolean"}}}
NOTATION = [r"\$|\\\(|\\\[|\\[a-zA-Z]+", r"[\[\(]\s*[-−]?\d+(?:\.\d+)?\s*(?:,\s*[-−]?\d+(?:\.\d+)?\s*)+[\]\)]",
            r"\d\s*[-−+*/=^×·]\s*[-−]?\d", r"\b[a-zA-Z]_\{?\w|\b[a-zA-Z]\^\{?\w"]
def notation(text): return [p for p in NOTATION if re.search(p, text)]

def sandbox(script, payload):
    p = subprocess.run([VENV_PY, "-I", os.path.join(HERE, script)], input=json.dumps(payload), capture_output=True, text=True, timeout=120)
    if p.returncode: return {"ok": False, "error": p.stderr.strip().splitlines()[-1]}
    return json.loads(p.stdout)

def render(q, latex):
    t = q["question"]
    for k, v in latex.items():
        t = t.replace("${" + k + "}$", "$" + v + "$").replace("{" + k + "}", "$" + v + "$")
    return t

def objective8(gen, trials, blind_name):
    gen_sys = fill(load(gen)); schema = SCHEMAS["strict7"]
    T = dict(calc=0, input_ok=0, input_fail=0, src=0, smp=0, src_ok=0, placeholder_bad=0, stray_numbers=0, agree=0,
             sc=0, four=0, tf=0, tf_true=0, tf_hit=0, concept=0, concept_ok=0, notation=0, classified_calc=0, quotes=0, qs=0)
    keys, SRC, fails, used_src = [], {}, [], []
    T["chunk_src"] = 0
    for t in range(trials):
        out, secs = chat(gen_sys, USER7, schema, 0.7); used_src.clear()
        print(f"\n=== {gen}/strict7 trial {t+1} ({secs:.0f}s) ===")
        for q in out["questions"]:
            T["qs"] += 1; T["quotes"] += all(e["quote"] in PASSAGE7 for e in q["evidence"])
            if not q["computable"]:
                T["concept"] += 1; T["concept_ok"] += sum(o["isCorrect"] for o in q["options"]) == 1
                hits = notation(q["question"] + " " + " ".join(o["text"] for o in q["options"]))
                verdict = None
                if hits:
                    T["notation"] += 1
                    opts = "\n".join(f"- {o['text']}" for o in q["options"])
                    verdict, _ = chat(None, fill(load("classify-v1"), question=q["question"], options=opts), CLASSIFY_SCHEMA, 0.2)
                    T["classified_calc"] += verdict["computable"]
                print(f"- concept notation={bool(hits)} classified={verdict and verdict['computable']}: {q['question'][:110]}"
                      + (f"\n    reason: {verdict['reason']}" if verdict else ""))
                continue
            T["calc"] += 1
            names = {i["name"] for i in q["inputs"]}; used_ph = set(re.findall(r"\{(\w+)\}", q["question"]))
            if names != used_ph: T["placeholder_bad"] += 1
            stray = re.findall(r"-?\d+", re.sub(r"\{\w+\}", "", q["question"]))
            T["stray_numbers"] += bool(stray)
            for i in q["inputs"]: T["src" if i["from"] == "source" else "smp"] += 1
            SEED[0] += 1
            inp = sandbox("inputs.py", {"inputs": q["inputs"], "constraint": q["constraint"], "answerProgram": q["answerProgram"],
                                        "type": q["type"], "quotes": [e["quote"] for e in q["evidence"]], "chunk": PASSAGE7,
                                        "used": keys, "usedSource": used_src, "seed": SEED[0]})
            head = f"- {q['type']} inputs={[(i['name'], i['kind'], i['from'], i['sourceText']) for i in q['inputs']]} placeholders_ok={names == used_ph} stray={stray}"
            if not inp["ok"]:
                T["input_fail"] += 1; fails.append(inp["error"]); print(head + f"\n    INPUT FAIL: {inp['error']}\n    q={q['question'][:120]}"); continue
            T["input_ok"] += 1; keys.append(inp["key"]); used_src += inp.get("sourceUsed", []); T["chunk_src"] += bool(inp.get("sourceUsed"))
            T["src_ok"] += sum(i["from"] == "source" for i in q["inputs"])
            rq = render({**q}, inp["latex"])
            prog = lambda src: inp["preamble"] + src
            a, aerr, _ = run_with_repair(prog(q["answerProgram"]), {**q, "question": rq})
            blind, _ = chat(None, fill(load(blind_name), passage=PASSAGE7, question=rq), PROGRAM_SCHEMA, 0.2)
            b, berr, _ = run_with_repair(blind["program"], {**q, "question": rq})
            ag = same(a, b); T["agree"] += ag
            print(head + f"\n    rendered: {rq[:160]}\n    constraint={q['constraint']!r} author={a and a['repr']!r} {aerr or ''} blind={b and b['repr']!r} {berr or ''} agree={ag}")
            if q["type"] == "true_false":
                T["tf"] += 1; T["tf_true"] += bool(inp.get("target")); T["tf_hit"] += bool(inp.get("hitTarget"))
                print(f"    target={inp.get('target')} hit={inp.get('hitTarget')}")
            if q["type"] == "single_choice" and ag:
                qq = {**q, "mistakes": [{**m, "program": prog(m["program"])} for m in q["mistakes"]]}
                summary, st = build(qq, a); T["sc"] += 1; T["four"] += st["n_opts"] == 4
                for k, v in st["src"].items(): SRC[k] = SRC.get(k, 0) + v
                print(f"    built {summary}")
    print(f"\n=== totals {gen}/strict7, {trials} trials ===")
    print(f"calc {T['calc']}: inputs ok {T['input_ok']} fail {T['input_fail']} {fails} | model said source {T['src']} (verified {T['src_ok']}) sample {T['smp']} | questions using chunk values {T['chunk_src']}")
    print(f"placeholder mismatch {T['placeholder_bad']} | questions with stray numbers {T['stray_numbers']} | distinct input sets {len(set(keys))}/{len(keys)} | programs AGREE {T['agree']}/{T['input_ok']}")
    print(f"single_choice built {T['sc']}, 4 options {T['four']} | sources {SRC} | true_false {T['tf']}: target True {T['tf_true']}, target hit {T['tf_hit']}")
    print(f"concept {T['concept']}: ok {T['concept_ok']}, with notation {T['notation']}, classified as calculation {T['classified_calc']} | exact quotes {T['quotes']}/{T['qs']}")

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[2] == "strict7": objective8(sys.argv[1], int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else "blind-v2")
    else: main()
