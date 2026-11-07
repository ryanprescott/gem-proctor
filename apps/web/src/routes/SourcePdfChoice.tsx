import { type OutlineRange, sourcesFilesSummary } from "@gem/shared/contracts";
import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { formatNumber } from "../format.ts";
import { ErrorMessage, Select } from "../ui/controls.tsx";
import tree from "../ui/ScopeTree.module.css";
import styles from "./Sources.module.css";
import { Warnings } from "./SourceWarnings.tsx";

/** What to make from a PDF: one source of all of it, or one per chapter ticked. */
export interface PdfPlan {
  perChapter: boolean;
  chapters: OutlineRange[];
}

/** The outline's top two depths: a book's parts and chapters, or its chapters and sections. */
const choosable = (outline: OutlineRange[]) => {
  const top = Math.min(...outline.map((o) => o.level));
  return outline.filter((o) => o.level <= top + 1);
};
const key = (o: OutlineRange) => `${o.page}:${o.level}:${o.title}`;

/**
 * A read PDF in the add-source form (SPEC §3C.1): what it holds, from the server's summary, and what to make of it.
 * Its text stays on the server: a source is made there from the stored pages, the whole PDF or a chapter's.
 */
export function PdfChoice({
  fileId,
  plan,
  onPlan,
}: {
  fileId: string;
  plan: PdfPlan;
  onPlan: (plan: PdfPlan) => void;
}) {
  const { t } = useTranslation();
  const summary = useQuery({
    queryKey: ["sources", "files", fileId, "summary"],
    queryFn: () => api.call(sourcesFilesSummary, { params: { id: fileId } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (summary.isPending) return <p>{t("common:loading")}</p>;
  if (!summary.data) return <ErrorMessage error={summary.error} />;
  const { file, outline, preview, characters } = summary.data;
  const chapters = outline.length > 0 ? choosable(outline) : [];
  const ticked = new Set(plan.chapters.map(key));
  const top = chapters.length > 0 ? Math.min(...chapters.map((o) => o.level)) : 0;
  return (
    <section aria-labelledby="pdf-result" className={styles.pdf}>
      <h3 id="pdf-result">{t("sources:pdf.resultTitle")}</h3>
      <p>
        {t("sources:pdf.summary", {
          name: file.filename,
          pages: formatNumber(file.pagesConverted ?? 0),
          sections: formatNumber(preview.sections.length),
          characters: formatNumber(characters),
        })}
      </p>
      <Warnings warnings={[...file.warnings, ...preview.warnings]} />
      {chapters.length > 0 ? (
        <>
          <Select
            label={t("sources:pdf.make")}
            selectedKey={plan.perChapter ? "chapters" : "whole"}
            onSelectionChange={(k) => onPlan({ perChapter: k === "chapters", chapters: plan.chapters })}
            options={[
              { id: "whole", label: t("sources:pdf.makeWhole") },
              { id: "chapters", label: t("sources:pdf.makeChapters") },
            ]}
          />
          {plan.perChapter ? (
            <fieldset className={tree.tree}>
              <legend className={tree.legend}>{t("sources:pdf.chapters")}</legend>
              <ul className={tree.level}>
                {chapters.map((o) => (
                  <li key={key(o)} style={{ paddingInlineStart: `${(o.level - top) * 1.25}rem` }}>
                    <Checkbox
                      className={tree.row}
                      isSelected={ticked.has(key(o))}
                      onChange={(on) =>
                        onPlan({
                          perChapter: true,
                          chapters: on
                            ? chapters.filter((c) => ticked.has(key(c)) || key(c) === key(o))
                            : plan.chapters.filter((c) => key(c) !== key(o)),
                        })
                      }
                    >
                      <span className={tree.box} aria-hidden="true" />
                      <span className={tree.title}>{o.title}</span>
                      <span className={tree.size}>
                        {t("sources:pdf.chapterPages", { first: formatNumber(o.page), last: formatNumber(o.lastPage) })}
                      </span>
                    </Checkbox>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
        </>
      ) : (
        <p>{t("sources:pdf.noOutline")}</p>
      )}
    </section>
  );
}
