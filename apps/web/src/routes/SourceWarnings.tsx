import type { SourceWarning } from "@gem/shared";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../format.ts";
import styles from "./Sources.module.css";

/** A source's or a conversion's warnings, in words. */
export function Warnings({ warnings }: { warnings: SourceWarning[] }) {
  const { t } = useTranslation();
  if (warnings.length === 0) return <p>{t("sources:preview.noWarnings")}</p>;
  return (
    <ul className={styles.warnings}>
      {warnings.map((w) => (
        <li key={`${w.code}:${w.heading ?? ""}`}>
          {w.code === "unbalanced_math" && w.heading
            ? t("sources:warnings.unbalanced_math_in", { heading: w.heading })
            : t(`sources:warnings.${w.code}`, {
                heading: w.heading ?? "",
                tokens: formatNumber(w.tokens ?? 0),
                count: w.count ?? 0,
              })}
        </li>
      ))}
    </ul>
  );
}
