// Companion check for no-literal-ui-string (SPEC §11.6):
//  - every t("key") / i18nKey="key" used in the web app exists in the `en` catalog;
//  - no catalog key is unused;
//  - every API error code (shared enum) has an `errors:<code>` entry.
// Keys are written fully qualified (`ns:path.to.key`). Dynamic keys are only allowed for the families
// below, each tied to a shared enum, so they stay checkable.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { ERROR_CODES, FIX_CODES, QUESTION_TYPES, QUIZ_ISSUE_CODES } from "@gem/shared";
import { AUDIT_ACTIONS, ROLES } from "@gem/shared/contracts";
import { Glob } from "bun";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..");
const WEB_SRC = join(ROOT, "apps", "web", "src");
const CATALOG_DIR = join(WEB_SRC, "i18n", "locales", "en");

/** Dynamic key families: `prefix` + one member of a shared enum. */
export const DYNAMIC_FAMILIES: Record<string, readonly string[]> = {
  "errors:": ERROR_CODES,
  "import:issues.": QUIZ_ISSUE_CODES,
  "import:fixes.": FIX_CODES,
  "common:roles.": ROLES,
  "admin:actions.": AUDIT_ACTIONS,
  "tests:types.": QUESTION_TYPES,
  "admin:targets.": ["user", "settings"],
};

const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

function flatten(obj: unknown, prefix: string, out: Map<string, string>) {
  if (typeof obj === "string") {
    out.set(prefix, obj);
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj))
      flatten(v, prefix.endsWith(":") ? `${prefix}${k}` : `${prefix}.${k}`, out);
  }
}

export function loadCatalog(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const file of readdirSync(CATALOG_DIR).filter((f) => f.endsWith(".json"))) {
    const ns = basename(file, ".json");
    flatten(JSON.parse(readFileSync(join(CATALOG_DIR, file), "utf8")), `${ns}:`, keys);
  }
  return keys;
}

/** The base key of a plural form (`x_one` → `x`). */
const pluralBase = (k: string) => {
  const s = PLURAL_SUFFIXES.find((suf) => k.endsWith(suf));
  return s ? k.slice(0, -s.length) : k;
};

interface Usage {
  literal: Map<string, string[]>;
  dynamic: Map<string, string[]>;
  problems: string[];
}

function keyExpressions(node: ts.Expression, file: string, sf: ts.SourceFile, usage: Usage) {
  const where = () => `${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const list = usage.literal.get(node.text) ?? [];
    list.push(where());
    usage.literal.set(node.text, list);
  } else if (ts.isTemplateExpression(node)) {
    const prefix = node.head.text;
    if (
      !(prefix in DYNAMIC_FAMILIES) ||
      node.templateSpans.length !== 1 ||
      node.templateSpans[0]?.literal.text !== ""
    ) {
      usage.problems.push(`${where()}: dynamic key \`${node.getText(sf)}\` is not one of the known families`);
      return;
    }
    const list = usage.dynamic.get(prefix) ?? [];
    list.push(where());
    usage.dynamic.set(prefix, list);
  } else if (ts.isConditionalExpression(node)) {
    keyExpressions(node.whenTrue, file, sf, usage);
    keyExpressions(node.whenFalse, file, sf, usage);
  } else if (ts.isParenthesizedExpression(node)) {
    keyExpressions(node.expression, file, sf, usage);
  } else {
    usage.problems.push(`${where()}: translation key must be a literal (got \`${node.getText(sf)}\`)`);
  }
}

export function scanUsage(): Usage {
  const usage: Usage = { literal: new Map(), dynamic: new Map(), problems: [] };
  for (const rel of new Glob("**/*.{ts,tsx}").scanSync({ cwd: WEB_SRC })) {
    if (rel.startsWith("i18n/") || /\.(test|spec|stories)\.tsx?$/.test(rel)) continue;
    const file = join(WEB_SRC, rel);
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isT =
          (ts.isIdentifier(callee) && callee.text === "t") ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "t" &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === "i18n");
        const first = node.arguments[0];
        if (isT && first) keyExpressions(first, file, sf, usage);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(sf) === "i18nKey" && node.initializer) {
        const init = node.initializer;
        if (ts.isStringLiteral(init)) keyExpressions(init, file, sf, usage);
        else if (ts.isJsxExpression(init) && init.expression) keyExpressions(init.expression, file, sf, usage);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return usage;
}

export function checkCatalogs(): string[] {
  const catalog = loadCatalog();
  const catalogBases = new Set([...catalog.keys()].map(pluralBase));
  const usage = scanUsage();
  const problems = [...usage.problems];

  for (const [key, where] of usage.literal) {
    if (!key.includes(":")) problems.push(`${where[0]}: key "${key}" must be namespaced (ns:key)`);
    else if (!catalog.has(key) && !catalogBases.has(key)) problems.push(`${where[0]}: missing catalog key "${key}"`);
  }

  // Every member of a used dynamic family must exist; error codes always (SPEC §11.6).
  const families = new Set([...usage.dynamic.keys(), "errors:"]);
  for (const prefix of families) {
    for (const member of DYNAMIC_FAMILIES[prefix] ?? []) {
      const full = `${prefix}${member}`;
      if (!catalog.has(full) && !catalogBases.has(full)) problems.push(`missing catalog key "${prefix}${member}"`);
    }
  }

  const inFamily = (k: string) => {
    const family = Object.keys(DYNAMIC_FAMILIES).find((p) => k.startsWith(p) && families.has(p));
    return !!family && (DYNAMIC_FAMILIES[family] ?? []).includes(k.slice(family.length));
  };
  for (const key of catalog.keys()) {
    const base = pluralBase(key);
    if (usage.literal.has(base) || usage.literal.has(key)) continue;
    if (inFamily(key) || inFamily(base)) continue;
    problems.push(`unused catalog key "${key}"`);
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkCatalogs();
  if (problems.length > 0) {
    console.error(`i18n catalog check failed (${problems.length}):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`i18n catalogs OK (${loadCatalog().size} keys)`);
}
