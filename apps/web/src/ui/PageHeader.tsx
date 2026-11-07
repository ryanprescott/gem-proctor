import type { ReactNode } from "react";
import styles from "./PageHeader.module.css";

/**
 * The top of a page: its title (the one `h1`), an optional line of context under it, and the page's own actions on
 * the right ("New session", "Import a test"), so they aren't forms further down.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** A short line above the title: where this page sits ("Sources"), or what it is. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className={styles.header}>
      <div className={styles.text}>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        {description ? <div className={styles.description}>{description}</div> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
