import i18n from "./i18n/index.ts";

/** Dates, numbers, percentages and durations always go through Intl (SPEC §1.3, P0.md A29). */
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

/** Points: up to two decimals, like the stored values (P1.md §4). */
export function formatPoints(n: number): string {
  return new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(n);
}

/** `percent` is 0–100. */
export function formatPercent(percent: number): string {
  return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 1 }).format(percent / 100);
}

/** A short duration in seconds, e.g. "1.25 sec" (model latencies). */
export function formatSeconds(ms: number): string {
  return new Intl.NumberFormat(locale(), {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
    maximumFractionDigits: 2,
  }).format(ms / 1000);
}

/** A running clock, e.g. "00:02:05" (the soft timer). Wraps after 24 hours, which a practice timer can live with. */
export function formatClock(ms: number): string {
  return new Intl.DateTimeFormat(locale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(Math.max(0, ms)));
}

/** A duration in words, e.g. "1 hr, 2 min, 5 sec". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const parts: [number, string][] = [
    [Math.floor(total / 3600), "hour"],
    [Math.floor((total % 3600) / 60), "minute"],
    [total % 60, "second"],
  ];
  const shown = parts.filter(([n], i) => n > 0 || (i === 2 && total < 60));
  const words = shown.map(([n, unit]) =>
    new Intl.NumberFormat(locale(), { style: "unit", unit, unitDisplay: "short" }).format(n),
  );
  return new Intl.ListFormat(locale(), { style: "narrow", type: "unit" }).format(words);
}
