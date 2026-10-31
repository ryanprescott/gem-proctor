import type { SourceSectionView } from "@gem/shared/contracts";
import { useMemo } from "react";
import { Checkbox } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../format.ts";
import { Markdown } from "./Markdown.tsx";
import styles from "./ScopeTree.module.css";

/** Everything under a section, itself included. */
function subtree(id: string, children: Map<string | null, SourceSectionView[]>): string[] {
  return [id, ...(children.get(id) ?? []).flatMap((c) => subtree(c.id, children))];
}

/**
 * The scope picker (SPEC §3C.4): a tree of real checkboxes, so Tab moves and Space ticks, with nothing extra to
 * learn. Ticking a heading ticks what's under it; a heading with only part of it ticked reads as mixed.
 */
export function ScopeTree({
  sections,
  selected,
  onChange,
  label,
}: {
  sections: SourceSectionView[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  label: string;
}) {
  const children = useMemo(() => {
    const map = new Map<string | null, SourceSectionView[]>();
    for (const s of sections) map.set(s.parentId, [...(map.get(s.parentId) ?? []), s]);
    return map;
  }, [sections]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    for (const s of subtree(id, children)) {
      if (on) next.add(s);
      else next.delete(s);
    }
    onChange(next);
  };

  return (
    <fieldset className={styles.tree}>
      <legend className={styles.legend}>{label}</legend>
      <Level parent={null} tree={children} selected={selected} toggle={toggle} />
    </fieldset>
  );
}

function Level({
  parent,
  tree,
  selected,
  toggle,
}: {
  parent: string | null;
  tree: Map<string | null, SourceSectionView[]>;
  selected: ReadonlySet<string>;
  toggle: (id: string, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const level = tree.get(parent) ?? [];
  if (level.length === 0) return null;
  return (
    <ul className={styles.level}>
      {level.map((s) => {
        const under = subtree(s.id, tree);
        const ticked = under.filter((id) => selected.has(id)).length;
        return (
          <li key={s.id}>
            <Checkbox
              className={styles.row}
              isSelected={ticked === under.length}
              isIndeterminate={ticked > 0 && ticked < under.length}
              onChange={(on) => toggle(s.id, on)}
            >
              <span className={styles.box} aria-hidden="true" />
              <span className={styles.title}>
                <Markdown inline>{s.title}</Markdown>
              </span>
              <span className={styles.size}>
                {t("sources:scope.sectionSize", { chunks: formatNumber(s.chunks), tokens: formatNumber(s.tokens) })}
              </span>
            </Checkbox>
            <Level parent={s.id} tree={tree} selected={selected} toggle={toggle} />
          </li>
        );
      })}
    </ul>
  );
}
