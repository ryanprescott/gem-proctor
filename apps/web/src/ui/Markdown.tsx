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

/** A heading inside quoted text is the source's, not the page's: it must not change the page's outline. */
const flatHeadings = Object.fromEntries(
  ["h1", "h2", "h3", "h4", "h5", "h6"].map((h) => [
    h,
    ({ children: c }: { children?: React.ReactNode }) => (
      <p>
        <strong>{c}</strong>
      </p>
    ),
  ]),
);

export function Markdown({
  children,
  inline = false,
  quoted = false,
}: {
  children: string;
  inline?: boolean;
  quoted?: boolean;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[[rehypeKatex, katexOptions]]}
      skipHtml
      components={{
        ...(quoted ? flatHeadings : {}),
        ...(inline ? { p: ({ children: c }: { children?: React.ReactNode }) => <>{c}</> } : {}),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
