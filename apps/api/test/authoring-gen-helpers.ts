// A scripted model for generation tests: it reads what the server sent, and answers like a model that follows the
// prompt. Behaviour that goes wrong on purpose is set per test.

import { DraftQuestion, SourceChunk } from "@gem/db";
import type { ChatReply } from "@gem/llm/mock";
import { eq } from "drizzle-orm";
import type { SourceEnv } from "./authoring-helpers.ts";
import { API, type Client } from "./helpers.ts";
import { promptOf } from "./l7-helpers.ts";

export interface Behaviour {
  /** The first single_choice of each batch is a calculation (the inner product). */
  computable?: boolean;
  /** What a calculation's author program is. */
  authorProgram?: string;
  /** What the blind solver sets `result` to, over the rendered vectors. */
  blindExpression?: string;
  /** What `classify` answers. */
  classifyComputable?: boolean;
  /** A concept question's text, to put notation in it. */
  conceptText?: string;
  /** Replaces the quote with words that aren't in the chunk. */
  badQuote?: boolean;
  /** Called with each generation request, which may return a reply instead. */
  intercept?: (body: Record<string, unknown>, n: number) => ChatReply | undefined;
}

export const INNER = "result = x.dot(y)";

const vector = (name: string) => ({ name, kind: "vector", size: [3], from: "sample", sourceText: "" });

function solver(expression: string, question: string) {
  const vectors = [...question.matchAll(/\\begin\{bmatrix\}(.*?)\\end\{bmatrix\}/g)].map(
    (m) =>
      `Matrix([${(m[1] as string)
        .split("&")
        .map((s) => s.trim())
        .join(", ")}])`,
  );
  const [x, y] = vectors;
  return JSON.stringify({ program: `from sympy import Matrix\nx = ${x}\ny = ${y}\nresult = ${expression}` });
}

const quoteOf = (text: string) =>
  text.split("\n").find((l) => l.trim().length > 30 && !l.startsWith("#")) ?? text.slice(0, 60);

let counter = 0;

export function scripted(behaviour: Behaviour = {}): (body: Record<string, unknown>) => ChatReply {
  let calls = 0;
  return (body) => {
    const messages = body.messages as { content: string }[];
    const content = messages.map((m) => m.content).join("\n");
    if (content.includes("Source chunk [")) {
      const forced = behaviour.intercept?.(body, calls++);
      if (forced) return forced;
      const chunks = [
        ...content.matchAll(/Source chunk \[([^\]]+)\]:\n([\s\S]*?)(?=\n\nSource chunk \[|\n\nObjectives:)/g),
      ].map((m) => ({ key: m[1] as string, text: m[2] as string }));
      const wanted = /Write (\d+) questions: ([^\n]+)\./.exec(content);
      const size = Number(wanted?.[1] ?? 1);
      const types = (wanted?.[2] ?? "single_choice").split(",").flatMap((p) => {
        const [n, type] = p.trim().split(" ");
        return Array.from({ length: Number(n) }, () => type as string);
      });
      const objectives = [...content.matchAll(/^(O\d+):/gm)].map((m) => m[1] as string);
      const chunk = chunks[0];
      if (!chunk) return { status: 500, body: { error: { message: "no chunk in the prompt" } } };
      const evidence = [
        {
          chunkId: chunk.key,
          quote: behaviour.badQuote ? "Words that are nowhere in this book." : quoteOf(chunk.text),
        },
      ];
      const questions = Array.from({ length: size }, (_, i) => {
        const type = types[i] ?? "single_choice";
        const base = { tempId: `g${++counter}`, objectiveIds: [objectives[i % objectives.length] ?? "O1"] };
        const topic = "Inner product";
        if (
          behaviour.computable &&
          i === 0 &&
          (type === "single_choice" || type === "numeric" || type === "true_false")
        ) {
          const tf = type === "true_false";
          return {
            ...base,
            type,
            topic,
            computable: true,
            evidence,
            inputs: [vector("x"), vector("y")],
            question: tf ? "Are {x} and {y} orthogonal?" : "What is the inner product of {x} and {y}?",
            constraint: "",
            answerProgram: behaviour.authorProgram ?? (tf ? "result = x.dot(y) == 0" : INNER),
            options: [],
            mistakes:
              type === "single_choice"
                ? [
                    { whyWrong: "adds the entries", program: "result = sum(x) + sum(y)" },
                    { whyWrong: "forgets a term", program: "result = x[0]*y[0] + x[1]*y[1]" },
                  ]
                : [],
            explanation: "Multiply the entries in pairs and add them up.",
          };
        }
        const common = {
          ...base,
          topic,
          computable: false,
          evidence,
          inputs: [],
          question: behaviour.conceptText ?? `Which statement about this idea is true? (${counter})`,
          constraint: "",
          answerProgram: "",
          mistakes: [],
          explanation: "It follows from the definition in the text.",
        };
        if (type === "true_false") {
          return {
            ...common,
            type,
            options: [
              { text: "True", isCorrect: true },
              { text: "False", isCorrect: false },
            ],
          };
        }
        if (type === "short_answer") return { ...common, type, options: [], acceptedAnswers: ["orthogonal"] };
        if (type === "multi_choice") {
          return {
            ...common,
            type,
            options: [
              { text: "It is zero for orthogonal vectors", isCorrect: true },
              { text: "It is a vector", isCorrect: false, whyWrong: "it is a number" },
              { text: "It is symmetric", isCorrect: true },
            ],
          };
        }
        return {
          ...common,
          type: "single_choice",
          options: [
            { text: `It is zero exactly when the vectors are orthogonal (${counter})`, isCorrect: true },
            { text: "It is a vector", isCorrect: false, whyWrong: "it is a number" },
            { text: "It is never negative", isCorrect: false, whyWrong: "it can be negative" },
          ],
        };
      });
      return JSON.stringify({ questions });
    }
    const { kind, question } = promptOf(body);
    if (kind === "blind")
      return solver(
        behaviour.blindExpression ?? (question.includes("orthogonal") ? "x.dot(y) == 0" : "x.dot(y)"),
        question,
      );
    if (kind === "classify") {
      return JSON.stringify({ computable: behaviour.classifyComputable ?? false, reason: "scripted" });
    }
    if (kind === "pick") return JSON.stringify({ option: 0, reason: "scripted" });
    return JSON.stringify({ program: "result = 0" });
  };
}

/** Every route a session needs, to the point of having questions to look at. */
export interface Ready {
  sessionId: string;
  objectiveIds: string[];
}

export async function waitFor<T>(what: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function sessionState(client: Client, id: string) {
  return (await client.get(`${API}/authoring/sessions/${id}`)).json();
}

/** Waits for generation and L7 to finish. */
export const review = (client: Client, id: string) =>
  waitFor("review", async () => {
    const detail = await sessionState(client, id);
    return detail.session?.status === "review" || detail.session?.status === "draft" ? detail : undefined;
  });

export async function flagged(env: SourceEnv) {
  const rows = await env.t.db.select().from(SourceChunk);
  return rows.filter((c) => c.flaggedAt !== null);
}

export async function draftsOf(env: SourceEnv, sessionId: string) {
  return env.t.db.select().from(DraftQuestion).where(eq(DraftQuestion.sessionId, sessionId));
}
