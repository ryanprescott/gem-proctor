import type { ModelRole, StructuredMode } from "@gem/shared";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "../../ui/controls.tsx";
import { useLive } from "../../ui/live.tsx";
import styles from "../Admin.module.css";

/** Query keys of the LLM page; everything under `LLM_KEY` belongs to it. */
export const LLM_KEY = ["admin", "llm"] as const;
export const ENDPOINTS_KEY = [...LLM_KEY, "endpoints"] as const;
export const ROLES_KEY = [...LLM_KEY, "roles"] as const;
export const STATS_KEY = [...LLM_KEY, "stats"] as const;
export const EVALS_KEY = [...LLM_KEY, "evals"] as const;

/** What a probe result fills in on the role dialog (P1.5.md §5: nothing is saved until the admin does). */
export interface RolePrefill {
  endpointId: string;
  model: string;
  structuredOutput?: StructuredMode;
  contextWindow?: number;
  maxInputTokens?: number;
  dimensions?: number;
}

export interface RoleDialogRequest {
  role: ModelRole;
  prefill?: RolePrefill;
}

export function useRoleName() {
  const { t } = useTranslation();
  return (role: ModelRole) => t(`admin:llm.roleNames.${role}`);
}

/** The outcome of an action: spoken, and shown as a toast. */
export function useFeedback() {
  const { t } = useTranslation();
  const { announce, notify } = useLive();
  return useMemo(
    () => ({
      done(message: string) {
        announce(message);
        notify(message);
      },
      failed(error: unknown) {
        announce(errorText(t, error));
      },
    }),
    [announce, notify, t],
  );
}

/** A table that scrolls on its own at narrow widths; the region takes focus so a keyboard can scroll it too. */
export function ScrollTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable (WCAG 2.1.1)
    <section className={styles.tableWrap} aria-label={label} tabIndex={0}>
      {children}
    </section>
  );
}
