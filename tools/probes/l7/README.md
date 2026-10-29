# L7 probe

Measures whether the generation model leaves computable answers to the sandbox (SPEC §3A.3.1). Results and findings: `docs/prompts/authoring-generate.md` §4.

```sh
python3 -m venv --without-pip --system-site-packages .venv && .venv/bin/python -m pip install sympy numpy
python3 -I probe.py <gen-prompt> <plain|strict|strict5|strict6|strict7> <trials> [blind-prompt] [objective]
# e.g. python3 -I probe.py gen-v4 strict 6            (fixed request: known true answers)
#      python3 -I probe.py gen-v4 strict 6 blind-v2 objective   (objective-only request: agreement + copying)
```

`LLM_DEV_BASE_URL` and `LLM_DEV_MODEL` override the endpoint. Prompts are in `prompts/`; `strict` adds the grammar union on `computable`; `strict6` (current) has no model-written options for calculation questions, and `distract.py` builds them locally. Throwaway tooling until the eval harness exists (P1.5).

Current: `python3 -I probe.py gen-v8 strict7 8`. It uses named inputs (`inputs.py`: values from the chunk first, else sampled), local distractors (`distract.py`), and the notation check with `classify-v1` on concept questions.
