import type { ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Button } from "./controls.tsx";
import styles from "./dialog.module.css";

/**
 * A modal confirmation (React Aria): focus moves into the dialog (to the cancel button, the safe choice),
 * is trapped there, and returns to the trigger on close; Escape cancels.
 */
export function ConfirmDialog({
  isOpen,
  onOpenChange,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  isPending,
  variant = "primary",
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  isPending?: boolean;
  variant?: "primary" | "danger";
}) {
  return (
    <ModalOverlay className={styles.overlay} isOpen={isOpen} onOpenChange={onOpenChange} isDismissable>
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog} role="alertdialog">
          <Heading slot="title" className={styles.title}>
            {title}
          </Heading>
          {children}
          <div className={styles.actions}>
            <Button variant="secondary" onPress={() => onOpenChange(false)} autoFocus>
              {cancelLabel}
            </Button>
            <Button variant={variant} onPress={onConfirm} isDisabled={isPending}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
