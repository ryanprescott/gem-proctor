import JSON5 from "json5";
import { z } from "zod";
import { effectiveType, isChoiceType, QUESTION_TYPES, type QuestionType } from "./quiz.ts";

/**
 * Lenient clean-up of model-produced quiz JSON (SPEC §3D.2). Pure; fixes formatting, never content:
 * it never changes question text, never invents options or answers, and never picks between two
 * plausible option matches. Every fix is recorded.
 */

export const FIX_CODES = [
  // JSON-level (also used by the LLM repair loop)
  "think_stripped",
  "extracted_json",
  "tolerant_parse",
  "smart_quotes",
  "truncated",
  // quiz-level
  "wrapped_array",
  "key_alias",
  "number_coerced",
  "option_to_string",
  "option_prefix_stripped",
  "answer_letter_resolved",
  "answer_index_resolved",
  "answer_prefix_resolved",
  "answer_snapped",
  "ids_renumbered",
  "total_questions_recomputed",
  "type_inferred",
] as const;
export const FixCode = z.enum(FIX_CODES);
export type FixCode = z.infer<typeof FixCode>;

export const NormalizationFix = z.object({
  code: FixCode,
  severity: z.enum(["info", "warning"]),
  path: z.array(z.union([z.string(), z.number()])),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type NormalizationFix = z.infer<typeof NormalizationFix>;

export interface NormalizeResult {
  /** The parsed (and, for quizzes, cleaned) value; `undefined` if no JSON could be recovered. */
  value: unknown;
  fixes: NormalizationFix[];
}

export interface NormalizeQuizOptions {
  /** Title for a bare array of questions (from the file name or the session). */
  title?: string;
}

type Path = NormalizationFix["path"];
type Params = NormalizationFix["params"];

class FixLog {
  readonly fixes: NormalizationFix[] = [];
  info(code: FixCode, path: Path = [], params: Params = {}) {
    this.fixes.push({ code, severity: "info", path, params });
  }
  warn(code: FixCode, path: Path = [], params: Params = {}) {
    this.fixes.push({ code, severity: "warning", path, params });
  }
}

// ── JSON-level ───────────────────────────────────────────────────────

interface ScanResult {
  /** Index just past the balanced value, or -1 if the input ends first. */
  end: number;
  /**
   * When incomplete: the last point where an object inside an array closed, at the shallowest such depth
   * (a whole question, not an evidence entry inside it), with the open stack after it.
   */
  lastElementClose?: { index: number; stack: string[] };
}

/** Scan one JSON(5)-ish value starting at an opening bracket, respecting strings and comments. */
function scanValue(text: string, start: number): ScanResult {
  const stack: string[] = [];
  const closes = new Map<number, { index: number; stack: string[] }>();
  let i = start;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '"' || c === "'" || c === "“") {
      const close = c === "“" ? "”" : c;
      i++;
      while (i < text.length && text[i] !== close) {
        if (text[i] === "\\") i++;
        i++;
      }
      if (i >= text.length) break;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const endComment = text.indexOf("*/", i + 2);
      if (endComment === -1) break;
      i = endComment + 1;
    } else if (c === "{" || c === "[") {
      stack.push(c);
    } else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) return { end: i + 1 };
      if (c === "}" && stack[stack.length - 1] === "[") {
        closes.set(stack.length, { index: i, stack: [...stack] });
      }
    }
    i++;
  }
  if (closes.size === 0) return { end: -1 };
  const shallowest = Math.min(...closes.keys());
  return { end: -1, lastElementClose: closes.get(shallowest) };
}

function tolerantParse(text: string, log: FixLog): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {}
  try {
    const value = JSON5.parse(text);
    log.info("tolerant_parse");
    return { ok: true, value };
  } catch {}
  const unsmart = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  if (unsmart !== text) {
    try {
      const value = JSON5.parse(unsmart);
      log.info("smart_quotes");
      log.info("tolerant_parse");
      return { ok: true, value };
    } catch {}
  }
  return { ok: false };
}

function candidateStarts(text: string): number[] {
  // Every opening bracket, in order.
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") starts.push(i);
  }
  return starts;
}

/**
 * Removes `<think>` blocks, but not the words `<think>` inside a JSON string: that's a model's value, not its reasoning.
 * Strings only count inside a bracket: prose before the JSON can hold a stray quote.
 */
function stripThink(text: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === "<" && text.slice(i, i + 7).toLowerCase() === "<think>") {
      const end = text.toLowerCase().indexOf("</think>", i);
      if (end === -1) break;
      i = end + 7;
      continue;
    }
    if (c === '"' && depth > 0) inString = true;
    if (c === "{" || c === "[") depth += 1;
    if ((c === "}" || c === "]") && depth > 0) depth -= 1;
    out += c;
  }
  return out;
}

function extractAndParse(text: string, log: FixLog): unknown {
  // Already clean JSON: nothing to record.
  try {
    return JSON.parse(text);
  } catch {}

  let body = text;
  const withoutThink = stripThink(body);
  if (withoutThink !== body) {
    log.info("think_stripped");
    body = withoutThink;
  }

  let extracted = false;
  const fence = /```[\w-]*[^\S\n]*\n([\s\S]*?)(?:```|$)/.exec(body);
  if (fence?.[1] !== undefined && /[{[]/.test(fence[1])) {
    extracted = true;
    body = fence[1];
  }
  const markExtracted = (slice: string) => {
    if (extracted || slice.trim() !== body.trim()) log.info("extracted_json");
  };

  // The first value that parses, in order of appearance. A value cut off by the length limit is
  // repaired by keeping its complete elements and dropping the partial last one.
  for (const s of candidateStarts(body)) {
    const scan = scanValue(body, s);
    if (scan.end !== -1) {
      const slice = body.slice(s, scan.end);
      const sub = new FixLog();
      const parsed = tolerantParse(slice, sub);
      if (parsed.ok) {
        markExtracted(slice);
        log.fixes.push(...sub.fixes);
        return parsed.value;
      }
      continue;
    }
    if (!scan.lastElementClose) continue;
    const { index, stack } = scan.lastElementClose;
    const closers = stack
      .slice()
      .reverse()
      .map((b) => (b === "{" ? "}" : "]"))
      .join("");
    const sub = new FixLog();
    const parsed = tolerantParse(body.slice(s, index + 1) + closers, sub);
    if (parsed.ok) {
      if (extracted || body.slice(0, s).trim() !== "") log.info("extracted_json");
      log.fixes.push(...sub.fixes);
      log.warn("truncated");
      return parsed.value;
    }
  }
  return undefined;
}

/**
 * Finds the JSON in a model reply: `<think>` blocks, fences, surrounding prose, trailing commas, a cut-off end.
 * JSON-level fixes only. Used by `normalizeQuiz` and by the LLM repair loop (SPEC §3B.3).
 */
export function extractJson(text: string): NormalizeResult {
  const log = new FixLog();
  const value = extractAndParse(text, log);
  return { value, fixes: log.fixes };
}

// ── Quiz-level ───────────────────────────────────────────────────────

const QUIZ_ALIASES: Record<string, string> = {
  quizTitle: "quiz_title",
  title: "quiz_title",
  quiz_name: "quiz_title",
  quizName: "quiz_title",
  topicsCovered: "topics_covered",
  topics: "topics_covered",
  totalQuestions: "total_questions",
  question_count: "total_questions",
  questionCount: "total_questions",
  num_questions: "total_questions",
};

const QUESTION_ALIASES: Record<string, string> = {
  question_number: "id",
  questionNumber: "id",
  number: "id",
  question_id: "id",
  questionId: "id",
  correct_answer: "correctAnswer",
  answer: "correctAnswer",
  correct: "correctAnswer",
  correct_answers: "correctAnswers",
  choices: "options",
  answers: "options",
  question_text: "question",
  questionText: "question",
  prompt: "question",
  question_type: "type",
  questionType: "type",
  accepted_answers: "acceptedAnswers",
  numeric_tolerance: "numericTolerance",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function applyAliases(obj: Record<string, unknown>, aliases: Record<string, string>, path: Path, log: FixLog) {
  for (const [from, to] of Object.entries(aliases)) {
    if (from in obj && !(to in obj)) {
      obj[to] = obj[from];
      delete obj[from];
      log.info("key_alias", path, { from, to });
    }
  }
}

const NUMERIC_STRING = /^\s*-?\d+(\.\d+)?\s*$/;

function coerceNumber(obj: Record<string, unknown>, key: string, path: Path, log: FixLog) {
  const v = obj[key];
  if (typeof v === "string" && NUMERIC_STRING.test(v)) {
    obj[key] = Number(v);
    log.info("number_coerced", [...path, key], { field: key });
  }
}

const OPTION_PREFIX = /^\s*(?:\(([A-Za-z])\)|([A-Za-z])[).:])\s*/;

function letterIndex(letter: string): number {
  return letter.toLowerCase().charCodeAt(0) - 97;
}

/** Strip `A)`, `a.`, `(c)` prefixes, only when every option carries the next letter in sequence. */
function stripOptionPrefixes(options: string[]): string[] | undefined {
  const stripped: string[] = [];
  for (const [i, o] of options.entries()) {
    const m = OPTION_PREFIX.exec(o);
    const letter = m?.[1] ?? m?.[2];
    if (!m || !letter || letterIndex(letter) !== i) return undefined;
    const rest = o.slice(m[0].length);
    if (rest.trim() === "") return undefined;
    stripped.push(rest);
  }
  return stripped;
}

/** Case, whitespace and LaTeX-spacing-insensitive key. Never equates different values ("1" vs "-1"). */
export function looseAnswerKey(s: string): string {
  return s
    .replace(/\\[,;:!> ]|\\q?quad\b|~/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*([^\p{L}\p{N}\s])\s*/gu, "$1")
    .toLowerCase();
}

type AnswerResolution = { kind: "exact" } | { kind: "resolved"; value: string; code: FixCode } | { kind: "unresolved" };

function resolveAnswer(raw: unknown, options: string[]): AnswerResolution {
  if (typeof raw === "string" && options.includes(raw)) return { kind: "exact" };

  if (typeof raw === "number" && Number.isInteger(raw)) {
    const asText = String(raw);
    if (options.includes(asText)) return { kind: "resolved", value: asText, code: "number_coerced" };
    // A bare integer is an index only when it can't be a value: never with numeric options.
    const numericOptions = options.some((o) => NUMERIC_STRING.test(o));
    if (!numericOptions && raw >= 0 && raw < options.length) {
      return { kind: "resolved", value: options[raw] as string, code: "answer_index_resolved" };
    }
    return { kind: "unresolved" };
  }
  if (typeof raw !== "string") return { kind: "unresolved" };

  // A bare letter: "B", "b)", "(c)", "D."
  const letterOnly = /^\s*\(?([A-Za-z])\)?[.):]?\s*$/.exec(raw);
  if (letterOnly?.[1]) {
    const idx = letterIndex(letterOnly[1]);
    if (idx >= 0 && idx < options.length) {
      return { kind: "resolved", value: options[idx] as string, code: "answer_letter_resolved" };
    }
    return { kind: "unresolved" };
  }

  // Letter plus the option text: "B) 2n − 1". The text must match that same option.
  const prefixed = OPTION_PREFIX.exec(raw);
  const letter = prefixed?.[1] ?? prefixed?.[2];
  if (prefixed && letter) {
    const idx = letterIndex(letter);
    const rest = raw.slice(prefixed[0].length);
    const option = options[idx];
    if (option !== undefined && looseAnswerKey(rest) === looseAnswerKey(option)) {
      return { kind: "resolved", value: option, code: "answer_prefix_resolved" };
    }
  }

  // Same value except for case, whitespace or LaTeX spacing; exactly one match or nothing.
  const key = looseAnswerKey(raw);
  const matches = options.filter((o) => looseAnswerKey(o) === key);
  if (matches.length === 1) return { kind: "resolved", value: matches[0] as string, code: "answer_snapped" };
  return { kind: "unresolved" };
}

function normalizeQuestion(q: Record<string, unknown>, index: number, log: FixLog) {
  const path: Path = ["questions", index];
  applyAliases(q, QUESTION_ALIASES, path, log);
  for (const key of ["id", "points", "numericTolerance"]) coerceNumber(q, key, path, log);
  const id = typeof q.id === "number" ? q.id : index + 1;

  if (Array.isArray(q.options)) {
    let options = q.options.map((o, j) => {
      if (typeof o === "number" || typeof o === "boolean") {
        log.info("option_to_string", [...path, "options", j], { id });
        return String(o);
      }
      return o;
    });
    if (options.every((o): o is string => typeof o === "string")) {
      const stripped = stripOptionPrefixes(options);
      if (stripped) {
        log.info("option_prefix_stripped", [...path, "options"], { id });
        // Answers may still carry the original prefixed text; map those first.
        if (typeof q.correctAnswer === "string") {
          const at = options.indexOf(q.correctAnswer);
          if (at !== -1) {
            log.info("answer_prefix_resolved", [...path, "correctAnswer"], {
              id,
              from: q.correctAnswer,
              to: stripped[at] as string,
            });
            q.correctAnswer = stripped[at];
          }
        }
        options = stripped;
      }
      const opts = options as string[];
      const res = resolveAnswer(q.correctAnswer, opts);
      if (res.kind === "resolved") {
        log.info(res.code, [...path, "correctAnswer"], { id, from: String(q.correctAnswer), to: res.value });
        q.correctAnswer = res.value;
      }
      if (Array.isArray(q.correctAnswers)) {
        q.correctAnswers = q.correctAnswers.map((a, j) => {
          const r = resolveAnswer(a, opts);
          if (r.kind !== "resolved") return a;
          log.info(r.code, [...path, "correctAnswers", j], { id, from: String(a), to: r.value });
          return r.value;
        });
      }
    }
    q.options = options;
  }

  if (typeof q.correctAnswer === "number" || typeof q.correctAnswer === "boolean") {
    log.info("number_coerced", [...path, "correctAnswer"], { field: "correctAnswer" });
    q.correctAnswer = String(q.correctAnswer);
  }

  // Type: infer when missing or inconsistent with options (SPEC §4).
  const hasOptions = Array.isArray(q.options);
  const declared = (QUESTION_TYPES as readonly string[]).includes(q.type as string)
    ? (q.type as QuestionType)
    : undefined;
  const inferred = effectiveType({ type: undefined, options: hasOptions ? [] : undefined });
  let next: QuestionType | undefined;
  if (declared === undefined) {
    if (q.type === undefined) next = inferred;
  } else if (isChoiceType(declared) !== hasOptions) {
    next = inferred;
  }
  if (next !== undefined) {
    log.info("type_inferred", [...path, "type"], { id, type: next, ...(declared ? { from: declared } : {}) });
    q.type = next;
  }
}

/**
 * `normalizeQuiz(text) → { value, fixes }` (SPEC §3D.2). Runs before Zod validation on import.
 */
export function normalizeQuiz(text: string, opts: NormalizeQuizOptions = {}): NormalizeResult {
  const log = new FixLog();
  let value = extractAndParse(text, log);
  if (value === undefined) return { value, fixes: log.fixes };

  if (Array.isArray(value)) {
    value = { quiz_title: opts.title ?? "", questions: value };
    log.info("wrapped_array", [], { title: opts.title ?? "" });
  }
  if (!isRecord(value)) return { value, fixes: log.fixes };

  const quiz = value;
  applyAliases(quiz, QUIZ_ALIASES, [], log);
  for (const key of ["chapter", "total_questions"]) coerceNumber(quiz, key, [], log);
  if (Array.isArray(quiz.chapters)) {
    quiz.chapters = quiz.chapters.map((c, j) => {
      if (typeof c === "string" && NUMERIC_STRING.test(c)) {
        log.info("number_coerced", ["chapters", j], { field: "chapters" });
        return Number(c);
      }
      return c;
    });
  }

  const questions = quiz.questions;
  if (!Array.isArray(questions)) return { value: quiz, fixes: log.fixes };
  questions.forEach((q, i) => {
    if (isRecord(q)) normalizeQuestion(q, i, log);
  });

  // Missing or duplicate ids → renumber 1..n in order.
  const ids = questions.map((q) => (isRecord(q) ? q.id : undefined));
  const valid = ids.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0);
  const unique = new Set(ids).size === ids.length;
  if (!valid || !unique) {
    questions.forEach((q, i) => {
      if (isRecord(q)) q.id = i + 1;
    });
    log.warn("ids_renumbered", ["questions"], { count: questions.length });
  }

  if (quiz.total_questions !== questions.length) {
    const stated = quiz.total_questions;
    quiz.total_questions = questions.length;
    log.warn("total_questions_recomputed", ["total_questions"], {
      from: typeof stated === "number" ? stated : String(stated ?? ""),
      to: questions.length,
    });
  }

  return { value: quiz, fixes: log.fixes };
}
