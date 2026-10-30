import { extractJson, type NormalizationFix } from "@gem/shared";
import type { z } from "zod";

/** The offline half of SPEC §3B.3: normalize → validate, the prompt-only instructions, per-item salvage. */

export interface OutputIssue {
  path: string;
  message: string;
}

export type ParsedOutput<T> =
  | { ok: true; value: T; fixes: NormalizationFix[] }
  | { ok: false; parsed: unknown; issues: OutputIssue[]; fixes: NormalizationFix[] };

function toIssues(error: z.ZodError): OutputIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function parseOutput<T>(text: string, schema: z.ZodType<T>): ParsedOutput<T> {
  const { value, fixes } = extractJson(text);
  if (value === undefined) {
    return { ok: false, parsed: undefined, issues: [{ path: "", message: "no JSON found" }], fixes };
  }
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data, fixes };
  return { ok: false, parsed: value, issues: toIssues(result.error), fixes };
}

/** A value of the schema's shape, for prompt-only models: the first option of every choice. */
export function exampleFromSchema(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null) return null;
  const s = schema as Record<string, unknown>;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.default !== undefined) return s.default;
  for (const key of ["anyOf", "oneOf"]) {
    const options = s[key];
    if (Array.isArray(options)) return exampleFromSchema(options[0]);
  }
  switch (s.type) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, exampleFromSchema(v)]));
    }
    case "array":
      return [exampleFromSchema(s.items)];
    case "string":
      return "...";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

export function promptOnlySystem(system: string, jsonSchema: unknown, example: unknown): string {
  return [
    system,
    "Reply with one JSON value that matches this JSON Schema, and nothing else.",
    `JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}`,
    `Example of the shape:\n${JSON.stringify(example, null, 2)}`,
  ]
    .filter((p) => p !== "")
    .join("\n\n");
}

export interface FailedItem {
  index: number;
  item: unknown;
  issues: OutputIssue[];
}

export interface SalvageOption {
  /** Dotted path to the array inside the output, e.g. `questions`. */
  path: string;
}

type Shaped = { shape?: Record<string, z.ZodType>; element?: z.ZodType };

/** The schema of the array's elements. Salvage is opt-in per call, so a path that isn't an array is a caller bug. */
function elementSchema(schema: z.ZodType, keys: string[]): z.ZodType {
  let node = schema as unknown as Shaped;
  for (const key of keys) {
    const next = node.shape?.[key];
    if (!next) throw new Error(`salvage path not in schema: ${keys.join(".")}`);
    node = next as unknown as Shaped;
  }
  if (!node.element) throw new Error(`salvage path is not an array: ${keys.join(".")}`);
  return node.element;
}

function readPath(value: unknown, keys: string[]): unknown {
  let node = value;
  for (const key of keys) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function withPath(value: unknown, keys: string[], items: unknown[]): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return items;
  const record = value as Record<string, unknown>;
  return { ...record, [key]: withPath(record[key], rest, items) };
}

/**
 * The output with only its valid items, or `undefined` if nothing can be saved: no valid item, or the object
 * is invalid outside the array. A rule on the array itself (e.g. its length) no longer applies to a partial batch.
 */
export function salvage<T>(
  parsed: unknown,
  schema: z.ZodType<T>,
  option: SalvageOption,
): { value: T; failedItems: FailedItem[] } | undefined {
  const keys = option.path.split(".");
  const items = readPath(parsed, keys);
  if (!Array.isArray(items)) return undefined;
  const element = elementSchema(schema, keys);
  const valid: unknown[] = [];
  const failedItems: FailedItem[] = [];
  for (const [index, item] of items.entries()) {
    const result = element.safeParse(item);
    if (result.success) valid.push(result.data);
    else failedItems.push({ index, item, issues: toIssues(result.error) });
  }
  if (valid.length === 0) return undefined;
  const candidate = withPath(parsed, keys, valid);
  const whole = schema.safeParse(candidate);
  if (whole.success) return { value: whole.data, failedItems };
  const outside = whole.error.issues.some((i) => !keys.every((k, n) => i.path[n] === k));
  return outside ? undefined : { value: candidate as T, failedItems };
}
