import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

/**
 * A short status in a pill: "Ready", "Published", "Failed". The words carry the meaning and the colour repeats it, so
 * it reads the same without colour (WCAG 1.4.1).
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
