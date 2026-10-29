import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";

/**
 * Quiz content (Markdown + `$…$` / `$$…$$` LaTeX). KaTeX renders HTML **and MathML** so screen readers
 * can read equations (SPEC §1.3), with `trust: false` and size limits; the LaTeX source stays available
 * in the MathML annotation.
 */
const katexOptions = {
  output: "htmlAndMathml" as const,
  trust: false,
  throwOnError: false,
  maxSize: 20,
  maxExpand: 200,
  strict: "ignore" as const,
};

export function Markdown({ children, inline = false }: { children: string; inline?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[[rehypeKatex, katexOptions]]}
      skipHtml
      components={inline ? { p: ({ children: c }) => <>{c}</> } : undefined}
    >
      {children}
    </ReactMarkdown>
  );
}
