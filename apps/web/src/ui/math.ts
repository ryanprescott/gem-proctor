import katex from "katex";

/**
 * The equations in Markdown that KaTeX can't read (docs/P2.2.md M22). A converter can produce LaTeX that looks right and
 * isn't; the creator sees which ones, as written, before saving. Code is left out.
 */
export function findUnparsedMath(markdown: string, limit = 20): string[] {
  const prose = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const found: string[] = [];
  const check = (source: string, displayMode: boolean) => {
    const tex = source.trim();
    if (tex === "" || found.length >= limit) return;
    try {
      katex.renderToString(tex, { throwOnError: true, displayMode, strict: "ignore", trust: false });
    } catch {
      found.push(tex);
    }
  };
  const rest = prose.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    check(tex, true);
    return " ";
  });
  for (const m of rest.matchAll(/(?<![\\$])\$([^\n$]+?)\$/g)) check(m[1] ?? "", false);
  return found;
}
