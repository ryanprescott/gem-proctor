import { Markdown } from "./Markdown.tsx";
import styles from "./Passage.module.css";

/**
 * A source passage with its quote marked. `<mark>` says it to assistive technology, and the underline to anyone who
 * can't see the colour. A quote that isn't found verbatim leaves the passage unmarked: nothing is marked by guesswork.
 */
export function Passage({ text, quote }: { text: string; quote?: string | undefined }) {
  const at = quote ? text.indexOf(quote) : -1;
  if (!quote || at < 0) {
    return (
      <div className={styles.passage}>
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  return (
    <div className={styles.passage}>
      <Markdown inline>{text.slice(0, at)}</Markdown> {/* Separate spans: each must stay valid math. */}
      <mark className={styles.quote}>
        <Markdown inline>{quote}</Markdown>
      </mark>{" "}
      <Markdown inline>{text.slice(at + quote.length)}</Markdown>
    </div>
  );
}
