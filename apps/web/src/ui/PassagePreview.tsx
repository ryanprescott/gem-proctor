import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./controls.tsx";
import { Dialog } from "./Dialog.tsx";
import { Passage } from "./Passage.tsx";
import styles from "./PassagePreview.module.css";

/**
 * A source passage in a short window, for a list that shows many (the questions in review): the window is scrolled
 * to the marked quote, so the quote is what you see, and fades at its edges where there's more. When the passage is
 * longer than the window, a button opens all of it in a dialog, quote marked, with `citation` (a link to the source)
 * at its top. The clipping is visual only: assistive technology reads the whole passage either way.
 */
export function PassagePreview({
  text,
  quote,
  citation,
  title,
}: {
  text: string;
  quote?: string | undefined;
  /** The citation, usually a link to the passage in its source. */
  citation?: ReactNode;
  /** The dialog's title: where the passage is from. */
  title: string;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState({ above: false, below: false });
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Scroll the window so the quote starts a little below its top edge.
    const mark = el.querySelector("mark");
    if (mark) el.scrollTop = Math.max(0, (mark as HTMLElement).offsetTop - el.offsetTop - 24);
    setClipped({ above: el.scrollTop > 0, below: el.scrollTop + el.clientHeight < el.scrollHeight - 1 });
  }, [text, quote]);

  return (
    <div className={styles.preview}>
      <div
        ref={box}
        className={[styles.window, clipped.above ? styles.fadeTop : null, clipped.below ? styles.fadeBottom : null]
          .filter(Boolean)
          .join(" ")}
      >
        <Passage text={text} quote={quote} />
      </div>
      {clipped.above || clipped.below ? (
        <Button variant="ghost" size="small" onPress={() => setOpen(true)}>
          {t("common:passage.readAll")}
        </Button>
      ) : null}
      {open ? (
        <Dialog
          isOpen
          onOpenChange={setOpen}
          title={title}
          size="large"
          actions={
            <Button variant="secondary" onPress={() => setOpen(false)}>
              {t("common:close")}
            </Button>
          }
        >
          {citation ? <p className={styles.citation}>{citation}</p> : null}
          <FullPassage text={text} quote={quote} />
        </Dialog>
      ) : null}
    </div>
  );
}

/** The whole passage in the dialog, its quote scrolled into view. */
function FullPassage({ text, quote }: { text: string; quote?: string | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("mark")?.scrollIntoView({ block: "center" });
  }, []);
  return (
    <div ref={ref} className={styles.full}>
      <Passage text={text} quote={quote} />
    </div>
  );
}
