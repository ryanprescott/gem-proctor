import type { ReactNode } from "react";
import { Button as AriaButton, Disclosure as AriaDisclosure, DisclosurePanel, Heading } from "react-aria-components";
import styles from "./Disclosure.module.css";

/**
 * A section that opens and closes (React Aria `Disclosure`): its title, a one-line summary of what's inside while it's
 * closed ("33 sections · 32 objectives"), and its content. For steps already done, details few people need, and
 * long lists. The title is a heading at `level`, and the button inside it says whether it's open.
 */
export function Disclosure({
  title,
  summary,
  children,
  defaultExpanded = false,
  isExpanded,
  onExpandedChange,
  level = 3,
  actions,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultExpanded?: boolean;
  isExpanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  level?: 2 | 3 | 4;
  /** Controls beside the title that aren't part of opening it. */
  actions?: ReactNode;
}) {
  return (
    <AriaDisclosure
      className={styles.disclosure}
      defaultExpanded={defaultExpanded}
      isExpanded={isExpanded}
      onExpandedChange={onExpandedChange}
    >
      <div className={styles.head}>
        <Heading level={level} className={styles.heading}>
          <AriaButton slot="trigger" className={styles.trigger}>
            <span className={styles.chevron} aria-hidden="true" />
            <span className={styles.title}>{title}</span>
            {summary ? <span className={styles.summary}>{summary}</span> : null}
          </AriaButton>
        </Heading>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
      <DisclosurePanel className={styles.panel}>{children}</DisclosurePanel>
    </AriaDisclosure>
  );
}
