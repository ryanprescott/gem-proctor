import {
  type Blueprint,
  exerciseSectionIds,
  QUESTION_TYPES,
  type QuestionType,
  TEST_TYPES,
  type TestType,
} from "@gem/shared";
import {
  authoringBatchRetry,
  authoringBlueprint,
  authoringGenerate,
  authoringGenerateCancel,
  authoringObjectivesPropose,
  authoringObjectivesPut,
  authoringPublish,
  authoringRevalidate,
  authoringScope,
  authoringSessionsGet,
  type BatchView,
  llmRoles,
  type ObjectiveInput,
  type ObjectiveView,
  type SessionDetail,
  type SessionProgress,
  type SourceSectionView,
  sourcesSections,
} from "@gem/shared/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { RequireRole } from "../auth.tsx";
import { formatNumber } from "../format.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button, ButtonLink, Card, ErrorMessage, Select, TextField } from "../ui/controls.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { partsOf, ScopeTree, scopeOf } from "../ui/ScopeTree.tsx";
import styles from "./Authoring.module.css";
import { ReviewSection } from "./AuthoringReview.tsx";

type Refresh = () => Promise<unknown>;

/**
 * What a source's scope step sends: the content sections ticked and left out (or nothing for all of it), and the
 * exercises chosen, which are a scope of their own.
 */
type Picked = { sectionIds?: string[]; excludeSectionIds?: string[]; exerciseSectionIds: string[] };

/**
 * One stage of a session (scope, objectives, blueprint, generation): a section that opens and closes, with a line
 * saying where it stands while closed. The stage you're on opens by default; the others stay out of the way.
 */
function Step({
  title,
  summary,
  open,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Disclosure title={title} summary={summary} defaultExpanded={open} level={2}>
      {children}
    </Disclosure>
  );
}

// ── Sources and scope ────────────────────────────────────────────────

function SourceScope({
  source,
  editable,
  onChange,
}: {
  source: SessionDetail["sources"][number];
  editable: boolean;
  onChange: (sourceId: string, picked: Picked) => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["source", source.sourceId, "sections", source.revisionNumber],
    queryFn: () =>
      api.call(sourcesSections, { params: { id: source.sourceId }, query: { revision: source.revisionNumber } }),
  });
  const sections = query.data?.sections ?? [];
  const { content, heads, exercise } = partsOf(sections);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [chosenExercises, setChosenExercises] = useState<Set<string> | null>(null);
  const current =
    selected ?? new Set((source.sectionIds ?? content.map((x) => x.id)).filter((id) => !exercise.has(id)));
  const currentExercises = chosenExercises ?? new Set(source.exerciseSectionIds);
  const report = (content: Set<string>, exercises: Set<string>) =>
    onChange(source.sourceId, { ...scopeOf(content, partsOf(sections).content), exerciseSectionIds: [...exercises] });
  return (
    <section aria-labelledby={`scope-${source.sourceId}`}>
      <h3 id={`scope-${source.sourceId}`}>
        {t("authoring:scope.source", { title: source.title, revision: source.revisionNumber })}
      </h3>
      <ErrorMessage error={query.error} />
      {editable ? (
        <ScopeTree
          sections={content}
          selected={current}
          label={t("authoring:scope.label", { title: source.title })}
          onChange={(next) => {
            setSelected(next);
            report(next, currentExercises);
          }}
        />
      ) : (
        <p>
          {t("authoring:scope.fixed", {
            count: source.sectionIds === null ? content.length : source.sectionIds.length,
          })}
        </p>
      )}
      {heads.length > 0 ? (
        <>
          <p className={styles.muted} role="note">
            {t("authoring:scope.exercisesHelp")}
          </p>
          {editable ? (
            <ScopeTree
              sections={heads}
              selected={currentExercises}
              label={t("authoring:scope.exercisesLabel", { title: source.title })}
              onChange={(next) => {
                // A chapter's exercises stand for what's under them, so what's sent is the heads and their subsections.
                const picked = new Set(heads.filter((h) => next.has(h.id)).map((h) => h.id));
                const full = new Set(
                  sections.filter((x) => exercise.has(x.id) && picked.has(rootOf(x, sections))).map((x) => x.id),
                );
                setChosenExercises(full);
                report(current, full);
              }}
            />
          ) : (
            <p>
              {t("authoring:scope.exercisesFixed", { count: heads.filter((h) => currentExercises.has(h.id)).length })}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

/** The exercises section a section sits under (itself, if it is one). */
function rootOf(section: SourceSectionView, sections: SourceSectionView[]): string {
  const byId = new Map(sections.map((x) => [x.id, x]));
  const ex = new Set(exerciseSectionIds(sections));
  let at = section;
  while (at.parentId && ex.has(at.parentId)) at = byId.get(at.parentId) as SourceSectionView;
  return at.id;
}

function ScopeSection({ detail, refresh, open }: { detail: SessionDetail; refresh: Refresh; open: boolean }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const editable = detail.session.status === "draft" && detail.questions.length === 0;
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<Record<string, Picked>>({});
  // A source nobody touched keeps the scope it has: its sections are in the cache, loaded for the picker above.
  const unchanged = (s: SessionDetail["sources"][number]): Picked => {
    const all =
      qc.getQueryData<{ sections: SourceSectionView[] }>(["source", s.sourceId, "sections", s.revisionNumber])
        ?.sections ?? [];
    const { content, exercise } = partsOf(all);
    const ticked = (s.sectionIds ?? content.map((x) => x.id)).filter((id) => !exercise.has(id));
    return { ...scopeOf(new Set(ticked), content), exerciseSectionIds: s.exerciseSectionIds };
  };
  const save = useMutation({
    mutationFn: () =>
      api.call(authoringScope, {
        params: { id: detail.session.id },
        body: {
          sources: detail.sources.map((s) => ({ sourceId: s.sourceId, ...(chosen[s.sourceId] ?? unchanged(s)) })),
        },
      }),
    onSuccess: async () => {
      await refresh();
      announce(t("authoring:scope.saved"));
    },
  });
  const revalidate = useMutation({
    mutationFn: () => api.call(authoringRevalidate, { params: { id: detail.session.id } }),
    onSuccess: async () => {
      await refresh();
      announce(t("authoring:scope.revalidated"));
    },
  });
  const changed = detail.sources.filter((s) => s.changed);
  return (
    <Step
      title={t("authoring:scope.title")}
      summary={detail.sources
        .map((s) => t("authoring:scope.source", { title: s.title, revision: s.revisionNumber }))
        .join(", ")}
      open={open || changed.length > 0}
    >
      {changed.length > 0 ? (
        <div className={styles.notice} role="status">
          <p>
            <strong>{t("authoring:scope.changedTitle")}</strong>{" "}
            {t("authoring:scope.changed", { titles: changed.map((s) => s.title).join(", ") })}
          </p>
          {detail.questions.length > 0 && detail.session.status === "review" ? (
            <Button variant="secondary" onPress={() => revalidate.mutate()} isDisabled={revalidate.isPending}>
              {t("authoring:scope.revalidate")}
            </Button>
          ) : null}
          <ErrorMessage error={revalidate.error} />
        </div>
      ) : null}
      {detail.sources.map((s) => (
        <SourceScope
          key={s.sourceId}
          source={s}
          editable={editable}
          onChange={(id, picked) => setChosen((c) => ({ ...c, [id]: picked }))}
        />
      ))}
      {editable ? (
        <div className={styles.row}>
          <Button onPress={() => save.mutate()} isDisabled={save.isPending}>
            {t("authoring:scope.save")}
          </Button>
        </div>
      ) : null}
      <ErrorMessage error={save.error} />
    </Step>
  );
}

// ── Objectives ───────────────────────────────────────────────────────

type Item = ObjectiveInput & { key: string };

const toItem = (o: ObjectiveView): Item => ({
  key: o.id,
  id: o.id,
  label: o.label,
  description: o.description,
  evidence: o.evidence,
  sectionIds: o.sectionIds,
  kind: o.kind,
});

/**
 * Each section's chapter, for grouping objectives: the first heading on its way down from the top that has text of its
 * own. A book's "Part" headings have none (they only hold chapters), so the chapters under them are what's found; a
 * lone title above everything is passed over the same way.
 */
function chapterIndex(sections: { id: string; parentId: string | null; title: string; chunks: number }[]) {
  const byId = new Map(sections.map((x) => [x.id, x]));
  const kids = new Map<string, number>();
  for (const x of sections) if (x.parentId) kids.set(x.parentId, (kids.get(x.parentId) ?? 0) + 1);
  const roots = sections.filter((x) => x.parentId === null);
  const container = (x: { id: string; parentId: string | null; chunks: number }) =>
    (kids.get(x.id) ?? 0) > 0 && (x.chunks === 0 || (x.parentId === null && roots.length === 1));
  const chapter = new Map<string, { id: string; title: string }>();
  for (const x of sections) {
    const path = [x];
    for (
      let up = x.parentId === null ? undefined : byId.get(x.parentId);
      up;
      up = up.parentId ? byId.get(up.parentId) : undefined
    ) {
      path.unshift(up);
    }
    const at = path.find((n) => !container(n)) ?? x;
    chapter.set(x.id, { id: at.id, title: at.title });
  }
  return chapter;
}

/** A list with more objectives than this opens with its chapters closed. */
const GROUP_COLLAPSE_ABOVE = 40;

function ObjectivesSection({ detail, refresh, open }: { detail: SessionDetail; refresh: Refresh; open: boolean }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const editable = detail.session.status === "draft" && detail.questions.length === 0;
  const [items, setItems] = useState<Item[]>(() => detail.objectives.map(toItem));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // The objective being edited in the dialog (a copy), or a new one; null when the dialog is closed.
  const [editing, setEditing] = useState<{ item: Item; isNew: boolean } | null>(null);
  const [chapterKey, setChapterKey] = useState("all");
  const sectionLists = useQueries({
    queries: detail.sources.map((s) => ({
      queryKey: ["source", s.sourceId, "sections", s.revisionNumber],
      queryFn: () => api.call(sourcesSections, { params: { id: s.sourceId }, query: { revision: s.revisionNumber } }),
    })),
  });
  const chapterOf = chapterIndex(sectionLists.flatMap((q) => q.data?.sections ?? []));
  const chapterFor = (o: Item) => chapterOf.get(o.sectionIds[0] ?? "");
  const chapters = [...new Map(items.flatMap((o) => chapterFor(o) ?? []).map((c) => [c.id, c])).values()];
  const shown = items.filter((o) => chapterKey === "all" || chapterFor(o)?.id === chapterKey);
  const seen = useRef(JSON.stringify(detail.objectives));
  useEffect(() => {
    const now = JSON.stringify(detail.objectives);
    if (now === seen.current) return;
    seen.current = now;
    setItems(detail.objectives.map(toItem));
    setPicked(new Set());
  }, [detail.objectives]);

  const save = useMutation({
    mutationFn: () =>
      api.call(authoringObjectivesPut, {
        params: { id: detail.session.id },
        body: {
          // An objective that came from the server keeps its id; one added here has none.
          objectives: items.map(({ key: _key, ...o }) => o),
        },
      }),
    onSuccess: async () => {
      await refresh();
      announce(t("authoring:objectives.saved"));
    },
  });
  const propose = useMutation({
    mutationFn: () => api.call(authoringObjectivesPropose, { params: { id: detail.session.id } }),
    onSuccess: async (res) => {
      await refresh();
      announce(
        res.notice === "headings_only"
          ? t("authoring:objectives.headingsOnly")
          : t("authoring:objectives.proposed", { count: res.objectives.length, rejected: res.rejected }),
      );
    },
  });
  const merge = () => {
    const chosen = items.filter((i) => picked.has(i.key));
    const [first] = chosen;
    if (!first || chosen.length < 2 || chosen.some((c) => c.kind !== first.kind)) return;
    const merged: Item = {
      ...first,
      label: chosen.map((c) => c.label).join(" / "),
      evidence: [...new Map(chosen.flatMap((c) => c.evidence).map((e) => [e.chunkId, e])).values()],
      sectionIds: [...new Set(chosen.flatMap((c) => c.sectionIds))],
    };
    setItems((list) => list.flatMap((i) => (i.key === first.key ? [merged] : picked.has(i.key) ? [] : [i])));
    setPicked(new Set());
  };
  const row = (o: Item) => {
    const n = items.indexOf(o);
    return (
      <li key={o.key} className={styles.objectiveRow}>
        {editable ? (
          <input
            type="checkbox"
            className={styles.objectivePick}
            aria-label={t("authoring:objectives.pick", { n: n + 1 })}
            checked={picked.has(o.key)}
            onChange={(e) =>
              setPicked((p) => {
                const next = new Set(p);
                if (e.target.checked) next.add(o.key);
                else next.delete(o.key);
                return next;
              })
            }
          />
        ) : null}
        <span className={styles.objectiveNumber} aria-hidden="true">
          {n + 1}
        </span>
        <div className={styles.objectiveText}>
          <span className={styles.objectiveLabel}>{o.label || t("authoring:objectives.untitled")}</span>
          {o.description ? <span className={styles.muted}>{o.description}</span> : null}
        </div>
        {o.kind === "exercise" ? <Badge>{t("authoring:objectives.exerciseBadge")}</Badge> : null}
        <Badge>{t("authoring:objectives.evidence", { count: o.evidence.length })}</Badge>
        {editable ? (
          <Menu
            label={t("authoring:objectives.actions", { n: n + 1 })}
            items={
              <>
                <MenuItem onAction={() => setEditing({ item: { ...o }, isNew: false })}>
                  {t("authoring:objectives.edit")}
                </MenuItem>
                <MenuItem danger onAction={() => setItems((l) => l.filter((i) => i.key !== o.key))}>
                  {t("authoring:objectives.removeShort")}
                </MenuItem>
              </>
            }
          />
        ) : null}
      </li>
    );
  };
  // With the whole list showing, a book's objectives sit under its chapters, not in one run of 100.
  const grouped = chapterKey === "all" && chapters.length > 1;
  const groups = [
    ...chapters.map((c) => ({
      id: c.id,
      title: c.title.replace(/[*_`#$]/g, "").trim(),
      items: shown.filter((o) => chapterFor(o)?.id === c.id),
    })),
    { id: "other", title: t("authoring:objectives.otherGroup"), items: shown.filter((o) => !chapterFor(o)) },
  ].filter((g) => g.items.length > 0);
  return (
    <Step
      title={t("authoring:objectives.title")}
      summary={t("authoring:objectives.summary", { count: items.length })}
      open={open}
    >
      <p className={styles.muted}>{t("authoring:objectives.help")}</p>
      {chapters.length > 1 ? (
        <div className={styles.row}>
          <Select
            label={t("authoring:objectives.chapter")}
            selectedKey={chapterKey}
            onSelectionChange={setChapterKey}
            options={[
              { id: "all", label: t("authoring:objectives.allObjectives", { count: items.length }) },
              ...chapters.map((c) => ({
                id: c.id,
                label: t("authoring:objectives.chapterOption", {
                  title: c.title.replace(/[*_`#$]/g, "").trim(),
                  count: items.filter((o) => chapterFor(o)?.id === c.id).length,
                }),
              })),
            ]}
          />
          {editable && chapterKey !== "all" ? (
            <>
              <Button
                variant="secondary"
                onPress={() => {
                  const kept = new Set(shown.map((o) => o.key));
                  setItems((l) => l.filter((i) => kept.has(i.key)));
                  setChapterKey("all");
                }}
              >
                {t("authoring:objectives.keepShown", { count: shown.length })}
              </Button>
              <Button
                variant="secondary"
                onPress={() => {
                  const gone = new Set(shown.map((o) => o.key));
                  setItems((l) => l.filter((i) => !gone.has(i.key)));
                  setChapterKey("all");
                }}
              >
                {t("authoring:objectives.removeShown", { count: shown.length })}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {grouped ? (
        <div className={styles.objectiveGroups}>
          {groups.map((g) => (
            <Disclosure
              key={g.id}
              level={3}
              variant="row"
              defaultExpanded={items.length <= GROUP_COLLAPSE_ABOVE}
              title={g.title}
              summary={t("authoring:objectives.groupCount", { count: g.items.length })}
            >
              <ol className={styles.objectiveList} aria-label={`${t("authoring:objectives.title")}: ${g.title}`}>
                {g.items.map(row)}
              </ol>
            </Disclosure>
          ))}
        </div>
      ) : (
        <ol className={styles.objectiveList} aria-label={t("authoring:objectives.title")}>
          {shown.map(row)}
        </ol>
      )}
      {editable ? (
        <div className={styles.row}>
          <Button
            variant="secondary"
            onPress={() =>
              setEditing({
                item: { key: crypto.randomUUID(), label: "", description: "", evidence: [], sectionIds: [] },
                isNew: true,
              })
            }
          >
            {t("authoring:objectives.add")}
          </Button>
          <Button
            variant="secondary"
            onPress={merge}
            isDisabled={picked.size < 2 || new Set(items.filter((i) => picked.has(i.key)).map((i) => i.kind)).size > 1}
          >
            {t("authoring:objectives.merge")}
          </Button>
          <Button variant="secondary" onPress={() => propose.mutate()} isDisabled={propose.isPending}>
            {propose.isPending ? t("authoring:objectives.proposing") : t("authoring:objectives.propose")}
          </Button>
          <Button
            onPress={() => save.mutate()}
            isDisabled={save.isPending || items.length === 0 || items.some((i) => i.label.trim() === "")}
          >
            {t("authoring:objectives.save")}
          </Button>
        </div>
      ) : null}
      <ErrorMessage error={save.error ?? propose.error} />
      {editing ? (
        <Dialog
          isOpen
          onOpenChange={(isOpen) => !isOpen && setEditing(null)}
          title={editing.isNew ? t("authoring:objectives.addTitle") : t("authoring:objectives.editTitle")}
          size="medium"
          actions={
            <>
              <Button variant="secondary" onPress={() => setEditing(null)}>
                {t("common:cancel")}
              </Button>
              <Button
                isDisabled={editing.item.label.trim() === ""}
                onPress={() => {
                  const item = editing.item;
                  setItems((l) => (editing.isNew ? [...l, item] : l.map((i) => (i.key === item.key ? item : i))));
                  setEditing(null);
                }}
              >
                {t("authoring:objectives.apply")}
              </Button>
            </>
          }
        >
          <TextField
            label={t("authoring:objectives.labelField")}
            value={editing.item.label}
            onChange={(label) => setEditing({ ...editing, item: { ...editing.item, label } })}
            autoFocus
          />
          <TextField
            label={t("authoring:objectives.descriptionField")}
            value={editing.item.description ?? ""}
            onChange={(description) => setEditing({ ...editing, item: { ...editing.item, description } })}
            multiline
            rows={3}
          />
          <p className={styles.muted}>{t("authoring:objectives.applyHelp")}</p>
        </Dialog>
      ) : null}
    </Step>
  );
}

// ── Blueprint ────────────────────────────────────────────────────────

const num = (s: string) => Math.max(0, Math.floor(Number(s) || 0));

function BlueprintSection({ detail, refresh, open }: { detail: SessionDetail; refresh: Refresh; open: boolean }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const editable = detail.session.status === "draft" && detail.questions.length === 0;
  const [bp, setBp] = useState<Blueprint | null>(detail.blueprint);
  const seen = useRef(JSON.stringify(detail.blueprint));
  useEffect(() => {
    const now = JSON.stringify(detail.blueprint);
    if (now === seen.current) return;
    seen.current = now;
    setBp(detail.blueprint);
  }, [detail.blueprint]);

  const apply = useMutation({
    mutationFn: (body: Partial<Blueprint> & { testType: TestType }) =>
      api.call(authoringBlueprint, { params: { id: detail.session.id }, body }),
    onSuccess: async (res) => {
      setBp(res.blueprint);
      seen.current = JSON.stringify(res.blueprint);
      await refresh();
      announce(t("authoring:blueprint.saved"));
    },
  });
  const sum = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((n, c) => n + (c ?? 0), 0);
  const label = (id: string) => detail.objectives.find((o) => o.id === id)?.label ?? id;
  return (
    <Step
      title={t("authoring:blueprint.title")}
      summary={bp ? t("authoring:blueprint.summary", { count: bp.questionCount }) : t("authoring:blueprint.notSet")}
      open={open}
    >
      <p className={styles.muted}>{t("authoring:blueprint.help")}</p>
      <Select
        label={t("authoring:blueprint.testType")}
        selectedKey={bp?.testType ?? detail.session.testType}
        isDisabled={!editable}
        onSelectionChange={(k) => apply.mutate({ testType: k as TestType })}
        options={TEST_TYPES.map((id) => ({ id, label: t(`authoring:testTypes.${id}`) }))}
      />
      {bp ? (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            apply.mutate(bp);
          }}
        >
          <TextField
            label={t("authoring:blueprint.count")}
            inputType="number"
            inputProps={{ min: 1 }}
            value={String(bp.questionCount)}
            onChange={(v) => setBp({ ...bp, questionCount: Math.max(1, num(v)) })}
            isDisabled={!editable}
          />
          <fieldset className={styles.numbers}>
            <legend>{t("authoring:blueprint.mix")}</legend>
            {QUESTION_TYPES.map((type: QuestionType) => (
              <TextField
                key={type}
                label={t(`tests:types.${type}`)}
                inputType="number"
                inputProps={{ min: 0 }}
                value={String(bp.mix[type] ?? 0)}
                onChange={(v) => setBp({ ...bp, mix: { ...bp.mix, [type]: num(v) } })}
                isDisabled={!editable}
              />
            ))}
          </fieldset>
          <p aria-live="polite" className={sum(bp.mix) === bp.questionCount ? styles.muted : styles.bad}>
            {t("authoring:blueprint.mixSum", { sum: sum(bp.mix), total: bp.questionCount })}
          </p>
          <fieldset className={styles.numbers}>
            <legend>{t("authoring:blueprint.perObjective")}</legend>
            {bp.perObjective.map((o) => (
              <TextField
                key={o.objectiveId}
                label={label(o.objectiveId)}
                inputType="number"
                inputProps={{ min: 0 }}
                value={String(o.count)}
                onChange={(v) =>
                  setBp({
                    ...bp,
                    perObjective: bp.perObjective.map((p) =>
                      p.objectiveId === o.objectiveId ? { ...p, count: num(v) } : p,
                    ),
                  })
                }
                isDisabled={!editable}
              />
            ))}
          </fieldset>
          <p
            aria-live="polite"
            className={
              sum(Object.fromEntries(bp.perObjective.map((p) => [p.objectiveId, p.count]))) === bp.questionCount
                ? styles.muted
                : styles.bad
            }
          >
            {t("authoring:blueprint.objectiveSum", {
              sum: bp.perObjective.reduce((n, p) => n + p.count, 0),
              total: bp.questionCount,
            })}
          </p>
          <TextField
            label={t("authoring:blueprint.style")}
            description={t("authoring:blueprint.styleHelp", { version: bp.styleVersion })}
            value={bp.style}
            onChange={(style) => setBp({ ...bp, style })}
            isDisabled={!editable}
            multiline
            rows={2}
          />
          <TextField
            label={t("authoring:blueprint.constraints")}
            description={t("authoring:blueprint.constraintsHelp")}
            value={bp.constraints}
            onChange={(constraints) => setBp({ ...bp, constraints })}
            isDisabled={!editable}
            multiline
            rows={2}
          />
          {editable ? (
            <div className={styles.row}>
              <Button type="submit" isDisabled={apply.isPending}>
                {t("authoring:blueprint.save")}
              </Button>
            </div>
          ) : null}
        </Form>
      ) : (
        <p>{t("authoring:blueprint.none")}</p>
      )}
      <ErrorMessage error={apply.error} />
    </Step>
  );
}

// ── Generate ─────────────────────────────────────────────────────────

function BatchRow({ batch, detail, refresh }: { batch: BatchView; detail: SessionDetail; refresh: Refresh }) {
  const { t } = useTranslation();
  const retry = useMutation({
    mutationFn: () => api.call(authoringBatchRetry, { params: { id: batch.id } }),
    onSuccess: refresh,
  });
  const names = batch.objectiveIds.map((id) => detail.objectives.find((o) => o.id === id)?.label ?? id).join(", ");
  const symbol = batch.status === "done" ? "✓ " : batch.status === "failed" ? "✕ " : "… ";
  return (
    <tr>
      <td data-label={t("authoring:batch.objective")}>{names}</td>
      <td data-label={t("authoring:batch.revision")}>{formatNumber(batch.revision)}</td>
      <td
        data-label={t("authoring:batch.state")}
        className={batch.status === "failed" ? styles.bad : batch.status === "done" ? styles.good : undefined}
      >
        <span aria-hidden="true">{symbol}</span>
        {t(`authoring:batch.status.${batch.status}`)}
      </td>
      <td data-label={t("authoring:batch.questions")}>
        {t("authoring:batch.written", { written: batch.written, size: batch.size })}
      </td>
      <td data-label={t("authoring:batch.problem")}>
        {batch.errorCode ? <span className={styles.bad}>{t(`errors:${batch.errorCode}`)}</span> : null}
        {batch.failedItems.length > 0 ? (
          <span> {t("authoring:batch.dropped", { count: batch.failedItems.length })}</span>
        ) : null}
        {batch.status === "failed" || batch.status === "cancelled" ? (
          <>
            {" "}
            <Button variant="secondary" onPress={() => retry.mutate()} isDisabled={retry.isPending}>
              {t("authoring:batch.retry")}
            </Button>
            <ErrorMessage error={retry.error} />
          </>
        ) : null}
      </td>
    </tr>
  );
}

function GenerateSection({ detail, refresh, open }: { detail: SessionDetail; refresh: Refresh; open: boolean }) {
  const { t } = useTranslation();
  const roles = useQuery({ queryKey: ["llm", "roles"], queryFn: () => api.call(llmRoles) });
  const cloud = (roles.data?.roles ?? []).filter(
    (r) => (r.role === "authoring.generate" || r.role === "embeddings") && r.location === "cloud",
  );
  const status = detail.session.status;
  const start = useMutation({
    mutationFn: () => api.call(authoringGenerate, { params: { id: detail.session.id } }),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: () => api.call(authoringGenerateCancel, { params: { id: detail.session.id } }),
    onSuccess: refresh,
  });
  const p = detail.progress;
  const summary =
    detail.blueprint === null && status === "draft"
      ? t("authoring:generate.needsBlueprint")
      : p.batches.length > 0
        ? t("authoring:generate.summary", { count: p.written })
        : t("authoring:generate.ready");
  return (
    <Step title={t("authoring:generate.title")} summary={summary} open={open}>
      {cloud.length > 0 ? (
        <p className={styles.notice} role="note">
          {t("authoring:generate.cloud", {
            endpoints: [...new Set(cloud.map((r) => r.endpointLabel ?? r.role))].join(", "),
          })}
        </p>
      ) : null}
      <div className={styles.row}>
        {status === "draft" && detail.questions.length === 0 ? (
          <Button onPress={() => start.mutate()} isDisabled={start.isPending || detail.blueprint === null}>
            {t("authoring:generate.start")}
          </Button>
        ) : null}
        {status === "generating" ? (
          <Button variant="secondary" onPress={() => cancel.mutate()} isDisabled={cancel.isPending}>
            {t("authoring:generate.cancel")}
          </Button>
        ) : null}
      </div>
      <ErrorMessage error={start.error ?? cancel.error} />
      {p.batches.length > 0 ? (
        <>
          <p aria-live="polite">
            {t("authoring:generate.progress", {
              written: formatNumber(p.written),
              checked: formatNumber(p.checked),
              pending: formatNumber(p.pending),
            })}
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.stack}>
              <caption className={styles.muted}>{t("authoring:batch.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("authoring:batch.objective")}</th>
                  <th scope="col">{t("authoring:batch.revision")}</th>
                  <th scope="col">{t("authoring:batch.state")}</th>
                  <th scope="col">{t("authoring:batch.questions")}</th>
                  <th scope="col">{t("authoring:batch.problem")}</th>
                </tr>
              </thead>
              <tbody>
                {p.batches.map((b) => (
                  <BatchRow key={b.id} batch={b} detail={detail} refresh={refresh} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Step>
  );
}

// ── Publish ──────────────────────────────────────────────────────────

function PublishSection({ detail }: { detail: SessionDetail }) {
  const { t } = useTranslation();
  const { notify } = useLive();
  const navigate = useNavigate();
  const [title, setTitle] = useState(detail.session.title);
  const ready = detail.questions.filter((q) => q.status === "accepted" || q.status === "locked");
  const publish = useMutation({
    mutationFn: () => api.call(authoringPublish, { params: { id: detail.session.id }, body: { title } }),
    onSuccess: (res) => {
      notify(t("authoring:publish.done"));
      navigate({ to: "/tests/$testId", params: { testId: res.testId } });
    },
  });
  if (detail.session.status === "published") return null;
  return (
    <Card title={t("authoring:publish.title")}>
      <p>{t("authoring:publish.help", { count: ready.length, total: detail.questions.length })}</p>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          publish.mutate();
        }}
      >
        <TextField label={t("authoring:publish.name")} value={title} onChange={setTitle} />
        <ErrorMessage error={publish.error} />
        <div className={styles.row}>
          <Button type="submit" isDisabled={publish.isPending || ready.length === 0 || title.trim() === ""}>
            {t("authoring:publish.publish")}
          </Button>
        </div>
      </Form>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────

function Session({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const qc = useQueryClient();
  const key = ["authoring", "session", sessionId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.call(authoringSessionsGet, { params: { id: sessionId } }),
  });
  const detail = query.data;
  useDocumentTitle(detail?.session.title ?? t("authoring:list.title"));
  const refresh: Refresh = () => qc.invalidateQueries({ queryKey: key });

  const live = detail?.session.status === "generating" || (detail?.progress.pending ?? 0) > 0;
  const said = useRef("");
  useServerState<SessionProgress>(live ? `/authoring/sessions/${sessionId}/events` : null, (state) => {
    // The state says what's true now; the page reads the rest again.
    void qc.invalidateQueries({ queryKey: key });
    const line =
      state.status === "generating"
        ? t("authoring:generate.progress", { written: state.written, checked: state.checked, pending: state.pending })
        : t("authoring:generate.finished", { count: state.written });
    if (line !== said.current) {
      said.current = line;
      announce(line);
    }
  });

  if (!detail) return <ErrorMessage error={query.error} />;
  // The stage you're on opens; the ones before it are done, the ones after it wait.
  const hasQuestions = detail.questions.length > 0;
  const generating = detail.session.status === "generating";
  const failedBatch = detail.progress.batches.some((b) => b.status === "failed");
  const STATUS_TONE = { draft: "neutral", generating: "accent", review: "warning", published: "success" } as const;
  return (
    <>
      <PageHeader
        title={detail.session.title}
        description={
          <span className={styles.headerMeta}>
            <Badge tone={STATUS_TONE[detail.session.status] ?? "neutral"}>
              {t(`authoring:session.status.${detail.session.status}`)}
            </Badge>
            <span>{t(`authoring:testTypes.${detail.session.testType}`)}</span>
          </span>
        }
        actions={
          <ButtonLink href="/authoring" variant="ghost">
            {t("authoring:session.back")}
          </ButtonLink>
        }
      />
      <ScopeSection detail={detail} refresh={refresh} open={detail.objectives.length === 0 && !hasQuestions} />
      <ObjectivesSection detail={detail} refresh={refresh} open={!hasQuestions && detail.blueprint === null} />
      <BlueprintSection detail={detail} refresh={refresh} open={!hasQuestions} />
      <GenerateSection detail={detail} refresh={refresh} open={!hasQuestions || generating || failedBatch} />
      {detail.questions.length > 0 ? <ReviewSection detail={detail} refresh={refresh} /> : null}
      {detail.questions.length > 0 ? <PublishSection detail={detail} /> : null}
    </>
  );
}

export function AuthoringSessionPage({ sessionId }: { sessionId: string }) {
  return <RequireRole minRole="proctor">{() => <Session sessionId={sessionId} />}</RequireRole>;
}
