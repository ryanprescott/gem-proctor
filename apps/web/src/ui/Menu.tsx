import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps,
  MenuTrigger,
  Popover,
  Separator,
} from "react-aria-components";
import styles from "./Menu.module.css";

/**
 * A button that opens a menu (React Aria `MenuTrigger`): for navigation groups, an account, and a row's actions,
 * so a page doesn't show every action as a button. Items are links (`href`) or actions (`onAction`); a destructive
 * one is `danger`. The trigger's accessible name is `label`, and what it shows is `children` (text, or an icon with
 * the label for screen readers only).
 */
export function Menu({
  label,
  children,
  items,
  variant = "ghost",
  placement = "bottom end",
  current = false,
}: {
  label: string;
  children?: ReactNode;
  items: ReactNode;
  variant?: "ghost" | "secondary" | "nav";
  placement?: "bottom start" | "bottom end";
  /** Marks the trigger: you're on one of the pages this menu leads to (the item itself says which). */
  current?: boolean;
}) {
  return (
    <MenuTrigger>
      <AriaButton
        // Named by what it shows when it shows text (voice control says what it sees, WCAG 2.5.3); `label` names the
        // menu, and the button when it's only an icon.
        aria-label={children ? undefined : label}
        className={[styles.trigger, styles[variant], current ? styles.current : null].filter(Boolean).join(" ")}
      >
        {children ?? <span aria-hidden="true">⋯</span>}
        {/* An element, not CSS content: generated content becomes part of the button's name. */}
        {variant === "nav" ? (
          <span aria-hidden="true" className={styles.caret}>
            ▾
          </span>
        ) : null}
      </AriaButton>
      <Popover placement={placement} className={styles.popover}>
        <AriaMenu aria-label={label} className={styles.menu}>
          {items}
        </AriaMenu>
      </Popover>
    </MenuTrigger>
  );
}

export function MenuItem({ danger, ...props }: MenuItemProps & { danger?: boolean }) {
  return <AriaMenuItem {...props} className={`${styles.item} ${danger ? styles.danger : ""}`} />;
}

export function MenuSeparator() {
  return <Separator className={styles.separator} />;
}

/** A line of text in a menu that isn't an item: who is signed in, say. */
export function MenuNote({ children }: { children: ReactNode }) {
  return (
    <AriaMenuItem isDisabled className={styles.note} textValue={typeof children === "string" ? children : ""}>
      {children}
    </AriaMenuItem>
  );
}
