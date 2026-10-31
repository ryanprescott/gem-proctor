import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Versioned prompt templates (SPEC §3B.4, P1.5.md §5). The active version changes by code review, not by a setting. */

export const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

export const ACTIVE_PROMPTS: Record<string, string> = {
  "authoring.generate": "gen-v8",
  "verify.solve.blind": "blind-v2",
  "verify.solve.classify": "classify-v1",
  "verify.solve.pick": "pick-v1",
  "program-repair": "repair-v1",
  "output-repair": "output-repair-v1",
};

export interface PromptSource {
  dir: string;
  active: Record<string, string>;
}

export const DEFAULT_PROMPTS: PromptSource = { dir: PROMPTS_DIR, active: ACTIVE_PROMPTS };

export interface LoadedPrompt {
  promptId: string;
  version: string;
  /** The file used: `<version>.md`, or a variant `<version>.<model-glob>.md`. */
  file: string;
  template: string;
}

export interface RenderedPrompt {
  system: string;
  /** Empty when the template has no user part. */
  user: string;
}

function globMatches(glob: string, model: string): boolean {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`).test(model);
}

/** The prompt's active version; a variant matching `model` wins, the most specific (longest glob) first. */
export function loadPrompt(promptId: string, model: string, source: PromptSource = DEFAULT_PROMPTS): LoadedPrompt {
  const version = source.active[promptId];
  if (!version) throw new Error(`unknown prompt: ${promptId}`);
  const dir = join(source.dir, promptId);
  const prefix = `${version}.`;
  const variants = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md") && f !== `${version}.md`)
    .map((f) => ({ file: f, glob: f.slice(prefix.length, -".md".length) }))
    .filter((v) => globMatches(v.glob, model))
    .sort((a, b) => b.glob.length - a.glob.length);
  const file = variants[0]?.file ?? `${version}.md`;
  return { promptId, version, file, template: readFileSync(join(dir, file), "utf8") };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
const USER_MARKER = /^<!-- user -->\s*$/m;

/** Fills every `{{var}}` in one pass, so a value containing `{{x}}` stays as it is. A missing or unused var throws. */
export function renderPrompt(prompt: LoadedPrompt, vars: Record<string, string>): RenderedPrompt {
  const used = new Set<string>();
  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (_all, name: string) => {
      const value = vars[name];
      if (value === undefined) throw new Error(`prompt ${prompt.promptId}: missing var ${name}`);
      used.add(name);
      return value;
    });
  // Split before filling, so a value can't move the boundary.
  const [system = "", user = ""] = prompt.template.split(USER_MARKER);
  const rendered = { system: fill(system).trim(), user: fill(user).trim() };
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length > 0) throw new Error(`prompt ${prompt.promptId}: unknown var ${unused.join(", ")}`);
  return rendered;
}
