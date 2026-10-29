import { effectiveType, type Question } from "./quiz.ts";

/**
 * Seeded shuffle for practice attempts (SPEC §6, P1 §5). The seed is 128 random bits as 32 hex digits; the
 * PRNG (sfc32) and Fisher–Yates live here so the server and tests get the same order for a seed, without
 * `Math.random`.
 */

export const SHUFFLE_SEED_RE = /^[0-9a-f]{32}$/;

/** A new seed from the platform's CSPRNG. */
export function newShuffleSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sfc32 seeded with the seed's four 32-bit words; returns uint32 values. */
function prng(seed: string): () => number {
  if (!SHUFFLE_SEED_RE.test(seed)) throw new Error("shuffle seed must be 32 lowercase hex digits");
  let a = Number.parseInt(seed.slice(0, 8), 16) >>> 0;
  let b = Number.parseInt(seed.slice(8, 16), 16) >>> 0;
  let c = Number.parseInt(seed.slice(16, 24), 16) >>> 0;
  let d = Number.parseInt(seed.slice(24, 32), 16) >>> 0;
  const next = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t;
  };
  for (let i = 0; i < 15; i++) next();
  return next;
}

/** Uniform integer in [0, n), by rejection (no modulo bias). */
function below(next: () => number, n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n);
  for (;;) {
    const x = next();
    if (x < limit) return x % n;
  }
}

function fisherYates<T>(next: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(next, i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface AttemptShuffle {
  /** Question ids in display order. */
  questionIds: number[];
  /** Display order of each choice question's options, by question id. `true_false` keeps `True, False`. */
  options: Record<number, string[]>;
}

/** Question order and per-question option order for an attempt; deterministic for a seed. */
export function shuffleAttempt(
  seed: string,
  questions: readonly Pick<Question, "id" | "type" | "options">[],
): AttemptShuffle {
  const next = prng(seed);
  const questionIds = fisherYates(
    next,
    questions.map((q) => q.id),
  );
  const options: Record<number, string[]> = {};
  for (const q of questions) {
    if (!q.options) continue;
    options[q.id] = effectiveType(q) === "true_false" ? [...q.options] : fisherYates(next, q.options);
  }
  return { questionIds, options };
}

/** The questions in display order, each with its options in display order. */
export function applyShuffle<Q extends Pick<Question, "id" | "options">>(
  shuffle: AttemptShuffle,
  questions: readonly Q[],
): Q[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return shuffle.questionIds.flatMap((id) => {
    const q = byId.get(id);
    if (!q) return [];
    const options = shuffle.options[id];
    return [options && q.options ? { ...q, options } : q];
  });
}
