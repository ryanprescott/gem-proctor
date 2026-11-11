import { exerciseSectionIds } from "@gem/shared";
import type { SourceSectionView } from "@gem/shared/contracts";
import { useMemo, useState } from "react";
import { Button, Checkbox } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../format.ts";
import { Markdown } from "./Markdown.tsx";
import styles from "./ScopeTree.module.css";

/**
 * What to send for a selection: nothing when every section is ticked (the whole source), else the ticked sections and,
 * exactly, the unticked ones. A ticked heading stands for what's under it on the server, so unticking one section of it
 * has to be said or it comes straight back.
 */
export function scopeOf(
  selected: ReadonlySet<string>,
  sections: readonly { id: string }[],
): { sectionIds?: string[]; excludeSectionIds?: string[] } {
  const left = sections.filter((s) => !selected.has(s.id)).map((s) => s.id);
  return left.length === 0 ? {} : { sectionIds: [...selected], excludeSectionIds: left };
}

/** A source with more sections than this is a book: its tree opens as chapters, and a session must say what it covers. */
export const LONG_SOURCE_SECTIONS = 25;

const plain = (title: string) => title.replace(/[*_`#$]/g, "").trim();

/** A source's sections as the picker shows them: the content (exercises aren't in this tree), and each chapter's exercises. */
export function partsOf(sections: SourceSectionView[]) {
  const exercise = new Set(exerciseSectionIds(sections));
  const content = sections.filter((x) => !exercise.has(x.id));
  const byId = new Map(sections.map((x) => [x.id, x]));
  // The exercises of a chapter are one choice, named for the chapter, with whatever is under them.
  const heads = sections
    .filter((x) => exercise.has(x.id) && !(x.parentId && exercise.has(x.parentId)))
    .map((x) => ({ ...x, parentId: null, title: x.parentId ? (byId.get(x.parentId)?.title ?? x.title) : x.title }));
  return { exercise, content, heads };
}

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

  // A long book opens as its chapters, and a short source as everything: a tree of hundreds of rows is no picker.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const many = sections.length > LONG_SOURCE_SECTIONS;
  const isOpen = (id: string) => opened.get(id) ?? !many;
  const setOpen = (id: string, open: boolean) => setOpened((m) => new Map(m).set(id, open));

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
      <Level parent={null} tree={children} selected={selected} toggle={toggle} isOpen={isOpen} setOpen={setOpen} />
    </fieldset>
  );
}

function Level({
  parent,
  tree,
  selected,
  toggle,
  isOpen,
  setOpen,
}: {
  parent: string | null;
  tree: Map<string | null, SourceSectionView[]>;
  selected: ReadonlySet<string>;
  toggle: (id: string, on: boolean) => void;
  isOpen: (id: string) => boolean;
  setOpen: (id: string, open: boolean) => void;
}) {
  const { t } = useTranslation();
  const level = tree.get(parent) ?? [];
  if (level.length === 0) return null;
  return (
    <ul className={styles.level}>
      {level.map((s) => {
        const under = subtree(s.id, tree);
        const ticked = under.filter((id) => selected.has(id)).length;
        const kids = (tree.get(s.id) ?? []).length > 0;
        const open = kids && isOpen(s.id);
        return (
          <li key={s.id}>
            <div className={styles.line}>
              {kids ? (
                <Button
                  className={styles.caret}
                  aria-expanded={open}
                  aria-label={t(open ? "sources:scope.collapse" : "sources:scope.expand", { title: plain(s.title) })}
                  onPress={() => setOpen(s.id, !open)}
                >
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </Button>
              ) : (
                <span className={styles.caret} aria-hidden="true" />
              )}
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
                  {kids && !open
                    ? t("sources:scope.ticked", { ticked, total: under.length })
                    : t("sources:scope.sectionSize", {
                        chunks: formatNumber(s.chunks),
                        tokens: formatNumber(s.tokens),
                      })}
                </span>
              </Checkbox>
            </div>
            {open ? (
              <Level parent={s.id} tree={tree} selected={selected} toggle={toggle} isOpen={isOpen} setOpen={setOpen} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
