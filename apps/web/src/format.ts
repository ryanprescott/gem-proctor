import i18n from "./i18n/index.ts";

/** Dates and numbers always go through Intl (SPEC §1.3, P0.md A29); percentages too, once results arrive (P1). */
const locale = () => i18n.resolvedLanguage ?? "en";

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(iso));
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(locale()).format(n);
}
