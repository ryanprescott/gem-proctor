import type { ReactNode } from "react";
import {
  Button as AriaButton,
  Link as AriaLink,
  Select as AriaSelect,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  type ButtonProps,
  FieldError,
  Input,
  type InputProps,
  Label,
  type LinkProps,
  ListBox,
  ListBoxItem,
  Popover,
  SelectValue,
  Text,
  TextArea,
} from "react-aria-components";
import { useTranslation } from "react-i18next";
import { ApiClientError } from "../api/client.ts";
import styles from "./controls.module.css";

/** Thin wrappers around React Aria Components with our styles (P0.md §5). Text always comes in translated. */

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonProps & { variant?: "primary" | "secondary" | "danger" }) {
  return <AriaButton {...props} className={[styles.button, styles[variant], className].filter(Boolean).join(" ")} />;
}

export function ButtonLink({ variant = "secondary", ...props }: LinkProps & { variant?: "primary" | "secondary" }) {
  return <AriaLink {...props} className={[styles.button, styles[variant]].join(" ")} />;
}

interface TextFieldProps extends Omit<AriaTextFieldProps, "children"> {
  label: string;
  description?: string;
  errorMessage?: string;
  multiline?: boolean;
  rows?: number;
  inputType?: InputProps["type"];
  inputProps?: Partial<InputProps>;
}

export function TextField({
  label,
  description,
  errorMessage,
  multiline,
  rows,
  inputType,
  inputProps,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className={styles.field}>
      <Label className={styles.label}>{label}</Label>
      {multiline ? (
        <TextArea className={styles.textarea} rows={rows ?? 6} />
      ) : (
        <Input className={styles.input} type={inputType} {...inputProps} />
      )}
      {description ? (
        <Text slot="description" className={styles.description}>
          {description}
        </Text>
      ) : null}
      <FieldError className={styles.fieldError}>{errorMessage}</FieldError>
    </AriaTextField>
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export function Select({
  label,
  options,
  selectedKey,
  onSelectionChange,
  isDisabled,
}: {
  label: string;
  options: SelectOption[];
  selectedKey: string;
  onSelectionChange: (key: string) => void;
  isDisabled?: boolean;
}) {
  return (
    <AriaSelect
      className={styles.field}
      selectedKey={selectedKey}
      onSelectionChange={(k) => onSelectionChange(String(k))}
      isDisabled={isDisabled}
    >
      <Label className={styles.label}>{label}</Label>
      <AriaButton className={styles.selectButton}>
        <SelectValue />
        <span aria-hidden="true">▾</span>
      </AriaButton>
      <Popover className={styles.popover}>
        <ListBox className={styles.listbox}>
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} className={styles.option} textValue={o.label}>
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

/** An API error, rendered from the catalog by its code (SPEC §1.3). */
export function ErrorMessage({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p className={styles.errorBox} role="alert">
      {errorText(t, error)}
    </p>
  );
}

export function errorText(t: (key: string, params?: Record<string, unknown>) => string, error: unknown): string {
  if (error instanceof ApiClientError) return t(`errors:${error.code}`, error.params);
  return t("errors:network");
}

export function Card({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <section className={styles.card}>
      {title ? <h2 className={styles.cardTitle}>{title}</h2> : null}
      {children}
    </section>
  );
}
