import type { ReactNode } from "react";
import { Dialog as AriaDialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import styles from "./dialog.module.css";

/**
 * A modal dialog with a title, its content, and actions at the foot: for work that would otherwise be a form on the
 * page (adding a source, a new session, editing one objective). Escape and a click outside close it unless
 * `isDismissable` is false; focus moves in and back, as React Aria does it.
 */
export function Dialog({
  isOpen,
  onOpenChange,
  title,
  children,
  actions,
  size = "small",
  isDismissable = true,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** The buttons at the foot: Cancel, then the main action. */
  actions?: ReactNode;
  size?: "small" | "medium" | "large";
  isDismissable?: boolean;
}) {
  return (
    <ModalOverlay className={styles.overlay} isOpen={isOpen} onOpenChange={onOpenChange} isDismissable={isDismissable}>
      <Modal className={[styles.modal, size === "small" ? null : styles[size]].filter(Boolean).join(" ")}>
        <AriaDialog className={styles.dialog}>
          <Heading slot="title" className={styles.title}>
            {title}
          </Heading>
          {children}
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
