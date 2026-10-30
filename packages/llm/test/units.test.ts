import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { type LoadedPrompt, loadPrompt, renderPrompt } from "../src/prompts.ts";
import { EndpointQueue, QueueRegistry } from "../src/queue.ts";
import { exampleFromSchema, parseOutput, promptOnlySystem, salvage } from "../src/structured.ts";

const source = { dir: join(import.meta.dir, "prompts"), active: { greet: "greet-v1" } };

describe("C29: templates", () => {
  const prompt = loadPrompt("greet", "plain-model", source);

  test("the active version is loaded, split into system and user", () => {
    expect(prompt).toMatchObject({ promptId: "greet", version: "greet-v1", file: "greet-v1.md" });
    expect(renderPrompt(prompt, { tone: "dry", name: "Ada" })).toEqual({
      system: "You greet people in the dry style.",
      user: "Greet Ada.",
    });
  });

  test("a missing var throws", () => {
    expect(() => renderPrompt(prompt, { tone: "dry" })).toThrow("missing var name");
  });

  test("an unknown var throws", () => {
    expect(() => renderPrompt(prompt, { tone: "dry", name: "Ada", extra: "x" })).toThrow("unknown var extra");
  });

  test("a value containing a placeholder or the marker stays as it is", () => {
    const r = renderPrompt(prompt, { tone: "{{name}}", name: "x\n<!-- user -->\ny" });
    expect(r.system).toBe("You greet people in the {{name}} style.");
    expect(r.user).toContain("x\n<!-- user -->\ny");
  });

  test("a variant file is chosen by model glob", () => {
    const chosen = loadPrompt("greet", "fancy-7b", source);
    expect(chosen.file).toBe("greet-v1.fancy-*.md");
    expect(chosen.version).toBe("greet-v1");
    expect(renderPrompt(chosen, { tone: "dry", name: "A" }).system).toStartWith("Variant:");
    expect(loadPrompt("greet", "not-fancy-7b", source).file).toBe("greet-v1.md");
  });

  test("an unknown prompt throws", () => {
    expect(() => loadPrompt("nope", "m", source)).toThrow("unknown prompt");
    const noUser: LoadedPrompt = { promptId: "p", version: "v", file: "f", template: "only {{a}}" };
    expect(renderPrompt(noUser, { a: "b" })).toEqual({ system: "only b", user: "" });
  });
});

describe("C8: output parsing", () => {
  const S = z.object({ a: z.number() });

  for (const [name, text, codes] of [
    ["clean", '{"a": 1}', []],
    ["prose", 'Sure! Here it is: {"a": 1} Hope that helps.', ["extracted_json"]],
    ["fence", '```json\n{"a": 1}\n```', ["extracted_json"]],
    ["think", '<think>hmm {"a": 2}</think>{"a": 1}', ["think_stripped"]],
    ["trailing comma", '{"a": 1,}', ["tolerant_parse"]],
  ] as const) {
    test(name, () => {
      const r = parseOutput(text, S);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual({ a: 1 });
      expect(r.fixes.map((f) => f.code) as string[]).toEqual([...codes]);
    });
  }

  test("invalid: the Zod issues; no JSON at all: one issue", () => {
    const r = parseOutput('{"a": "x"}', S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("a");
    const none = parseOutput("no json here", S);
    if (!none.ok) expect(none.issues).toEqual([{ path: "", message: "no JSON found" }]);
  });

  test("the schema and the example go in the system message", () => {
    const schema = { type: "object", properties: { a: { type: "number" }, b: { enum: ["x", "y"] } } };
    const example = exampleFromSchema(schema);
    expect(example).toEqual({ a: 0, b: "x" });
    const system = promptOnlySystem("Base.", schema, example);
    expect(system).toStartWith("Base.");
    expect(system).toContain('"enum"');
    expect(system).toContain('"b": "x"');
  });
});

describe("C10: salvage", () => {
  const Q = z.object({ text: z.string() });
  const S = z.object({ title: z.string(), questions: z.array(Q).length(4) });

  test("keeps the valid items, even under a rule on the array", () => {
    const parsed = { title: "t", questions: [{ text: "a" }, { nope: 1 }, { text: "b" }, { text: "c" }] };
    const r = salvage(parsed, S, { path: "questions" });
    expect(r?.value.questions.map((q) => q.text)).toEqual(["a", "b", "c"]);
    expect(r?.failedItems).toHaveLength(1);
    expect(r?.failedItems[0]).toMatchObject({ index: 1, item: { nope: 1 } });
  });

  test("nothing valid, or invalid outside the array: undefined", () => {
    expect(salvage({ title: "t", questions: [{ x: 1 }] }, S, { path: "questions" })).toBeUndefined();
    expect(salvage({ questions: [{ text: "a" }] }, S, { path: "questions" })).toBeUndefined();
    expect(salvage(undefined, S, { path: "questions" })).toBeUndefined();
  });

  test("a nested path; a path that's not in the schema is a caller bug", () => {
    const N = z.object({ batch: z.object({ items: z.array(z.number()) }) });
    expect(salvage({ batch: { items: [1, "x"] } }, N, { path: "batch.items" })?.value).toEqual({
      batch: { items: [1] },
    });
    expect(() => salvage({ nope: [] }, S, { path: "nope" })).toThrow("salvage path");
  });
});

describe("C13: queue", () => {
  /** A call the test finishes by hand. */
  function gate() {
    let open = () => {};
    const closed = new Promise<void>((resolve) => (open = resolve));
    return { open, closed };
  }

  test("concurrency 1: two callers × 3 are dispatched alternately, one in flight", async () => {
    const q = new EndpointQueue(1);
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const call = (key: string, n: number) =>
      q.run(key, undefined, async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        order.push(`${key}${n}`);
        await Bun.sleep(1);
        inFlight--;
      });
    await Promise.all(["a", "b"].flatMap((k) => [1, 2, 3].map((n) => call(k, n))));
    expect(order).toEqual(["a1", "b1", "a2", "b2", "a3", "b3"]);
    expect(peak).toBe(1);
  });

  test("a caller arriving late still takes its turn; FIFO within a key", async () => {
    const q = new EndpointQueue(1);
    const order: string[] = [];
    const first = gate();
    const calls = [
      q.run("a", undefined, async () => {
        order.push("a1");
        await first.closed;
      }),
      q.run("a", undefined, async () => void order.push("a2")),
      q.run("a", undefined, async () => void order.push("a3")),
      q.run("b", undefined, async () => void order.push("b1")),
    ];
    first.open();
    await Promise.all(calls);
    expect(order).toEqual(["a1", "b1", "a2", "a3"]);
  });

  test("concurrency 2 allows two", async () => {
    const q = new EndpointQueue(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4].map(() =>
        q.run("k", undefined, async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Bun.sleep(2);
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test("an aborted queued call never runs, and the others go on", async () => {
    const q = new EndpointQueue(1);
    const first = gate();
    const ran: string[] = [];
    const a = q.run("a", undefined, async () => first.closed);
    const abort = new AbortController();
    const b = q.run("b", abort.signal, async () => void ran.push("b"));
    const c = q.run("c", undefined, async () => void ran.push("c"));
    abort.abort(new Error("stop"));
    expect(b).rejects.toThrow("stop");
    first.open();
    await a;
    await c;
    expect(ran).toEqual(["c"]);
  });

  test("an already aborted signal is refused", () => {
    const q = new EndpointQueue(1);
    expect(q.run("a", AbortSignal.abort(new Error("no")), async () => 1)).rejects.toThrow("no");
  });

  test("a changed concurrency builds a new queue; the same one is reused otherwise", () => {
    const r = new QueueRegistry();
    const q = r.for("e", 1);
    expect(r.for("e", 1)).toBe(q);
    expect(r.for("e", 2)).not.toBe(q);
    expect(r.for("e", 2).concurrency).toBe(2);
  });
});
