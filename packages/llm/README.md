# @gem/llm

The model-agnostic LLM layer (SPEC §3B, `docs/P1.5.md`): `LlmRuntime` (`generateObject`, `streamObject`, `embed`), the provider registry, per-endpoint queues, structured-output modes with the repair loop, versioned prompts and call logging. It is the only package that imports `ai` or `@ai-sdk/*`.

- `src/providers/`: one file per provider, listed in `src/providers/index.ts`. Adding a provider needs nothing else.
- `prompts/<promptId>/<version>.md`: templates with `{{var}}` placeholders. A line `<!-- user -->` separates the system message from the user message. The active version of each prompt is a constant in `src/prompts.ts`. A per-model variant is a file `<version>.<model-glob>.md`.
- `evals/<name>/eval.json`: eval sets, run by the `llm.eval` job and by `bun run llm:eval <set>`.
- `mock/server.ts`: the mock OpenAI-compatible server used by the tests (`Bun.serve`).
