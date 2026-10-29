import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./live.module.css";

/**
 * UI message helpers (P0.md §5, SPEC §13 Q14): `notify(message)` shows a toast in a status region and
 * `announce(message)` speaks through a polite live region. Both take already-translated text, so the
 * no-literal-ui-string rule (F4) forbids literals as their first argument.
 */
interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

interface Live {
  notify(message: string, tone?: Toast["tone"]): void;
  announce(message: string): void;
}

const LiveContext = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [polite, setPolite] = useState("");
  const nextId = useRef(1);

  const announce = useCallback((message: string) => {
    // Clear first so repeating the same message is announced again.
    setPolite("");
    window.setTimeout(() => setPolite(message), 50);
  }, []);

  const notify = useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = nextId.current++;
    setToasts((ts) => [...ts, { id, message, tone }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 8000);
  }, []);

  const value = useMemo(() => ({ notify, announce }), [notify, announce]);

  return (
    <LiveContext.Provider value={value}>
      {children}
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true" data-testid="live-region">
        {polite}
      </div>
      <section className={styles.toasts} aria-label={t("common:toasts.region")}>
        <div role="status">
          <ul className={styles.toastList}>
            {toasts.map((toast) => (
              <li key={toast.id} className={toast.tone === "error" ? styles.toastError : styles.toast}>
                <span>{toast.message}</span>
                <button
                  type="button"
                  className={styles.dismiss}
                  aria-label={t("common:toasts.dismiss")}
                  onClick={() => setToasts((ts) => ts.filter((x) => x.id !== toast.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </LiveContext.Provider>
  );
}

export function useLive(): Live {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive outside LiveProvider");
  return ctx;
}

/** Keeps document.title in sync with the page (translated). */
export function useDocumentTitle(title: string) {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = t("common:documentTitle", { page: title });
  }, [title, t]);
}
