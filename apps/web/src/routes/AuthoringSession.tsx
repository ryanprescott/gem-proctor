import { type Blueprint, QUESTION_TYPES, type QuestionType, TEST_TYPES, type TestType } from "@gem/shared";
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
  sourcesSections,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { RequireRole } from "../auth.tsx";
import { formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { ScopeTree } from "../ui/ScopeTree.tsx";
import styles from "./Authoring.module.css";
import { ReviewSection } from "./AuthoringReview.tsx";

type Refresh = () => Promise<unknown>;

// ── Sources and scope ────────────────────────────────────────────────

function SourceScope({
  source,
  editable,
  onChange,
}: {
  source: SessionDetail["sources"][number];
  editable: boolean;
  onChange: (sourceId: string, ids: string[] | null) => void;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["source", source.sourceId, "sections", source.revisionNumber],
    queryFn: () =>
      api.call(sourcesSections, { params: { id: source.sourceId }, query: { revision: source.revisionNumber } }),
  });
  const sections = query.data?.sections ?? [];
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const current = selected ?? new Set(source.sectionIds ?? sections.map((s) => s.id));
  return (
    <section aria-labelledby={`scope-${source.sourceId}`}>
      <h3 id={`scope-${source.sourceId}`}>
        {t("authoring:scope.source", { title: source.title, revision: source.revisionNumber })}
      </h3>
      <ErrorMessage error={query.error} />
      {editable ? (
        <ScopeTree
          sections={sections}
          selected={current}
          label={t("authoring:scope.label", { title: source.title })}
          onChange={(next) => {
            setSelected(next);
            onChange(source.sourceId, next.size === sections.length ? null : [...next]);
          }}
        />
      ) : (
        <p>
          {t("authoring:scope.fixed", {
            count: source.sectionIds === null ? sections.length : source.sectionIds.length,
          })}
        </p>
      )}
    </section>
  );
}

function ScopeSection({ detail, refresh }: { detail: SessionDetail; refresh: Refresh }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const editable = detail.session.status === "draft" && detail.questions.length === 0;
  const [chosen, setChosen] = useState<Record<string, string[] | null>>({});
  const save = useMutation({
    mutationFn: () =>
      api.call(authoringScope, {
        params: { id: detail.session.id },
        body: {
          sources: detail.sources.map((s) => {
            const ids = s.sourceId in chosen ? chosen[s.sourceId] : s.sectionIds;
            return ids ? { sourceId: s.sourceId, sectionIds: ids } : { sourceId: s.sourceId };
          }),
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
    <Card title={t("authoring:scope.title")}>
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
          onChange={(id, ids) => setChosen((c) => ({ ...c, [id]: ids }))}
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
    </Card>
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
});

function ObjectivesSection({ detail, refresh }: { detail: SessionDetail; refresh: Refresh }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const editable = detail.session.status === "draft" && detail.questions.length === 0;
  const [items, setItems] = useState<Item[]>(() => detail.objectives.map(toItem));
  const [picked, setPicked] = useState<Set<string>>(new Set());
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
  const edit = (key: string, patch: Partial<Item>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const merge = () => {
    const chosen = items.filter((i) => picked.has(i.key));
    const [first] = chosen;
    if (!first || chosen.length < 2) return;
    const merged: Item = {
      ...first,
      label: chosen.map((c) => c.label).join(" / "),
      evidence: [...new Map(chosen.flatMap((c) => c.evidence).map((e) => [e.chunkId, e])).values()],
      sectionIds: [...new Set(chosen.flatMap((c) => c.sectionIds))],
    };
    setItems((list) => list.flatMap((i) => (i.key === first.key ? [merged] : picked.has(i.key) ? [] : [i])));
    setPicked(new Set());
  };
  return (
    <Card title={t("authoring:objectives.title")}>
      <p>{t("authoring:objectives.help")}</p>
      <ul className={styles.questions}>
        {items.map((o, n) => (
          <li key={o.key} className={styles.objective}>
            <TextField
              label={t("authoring:objectives.label", { n: n + 1 })}
              value={o.label}
              onChange={(label) => edit(o.key, { label })}
              isDisabled={!editable}
            />
            <TextField
              label={t("authoring:objectives.description", { n: n + 1 })}
              value={o.description ?? ""}
              onChange={(description) => edit(o.key, { description })}
              isDisabled={!editable}
              multiline
              rows={2}
            />
            <p className={styles.muted}>{t("authoring:objectives.evidence", { count: o.evidence.length })}</p>
            {editable ? (
              <div className={styles.row}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(o.key)}
                    onChange={(e) =>
                      setPicked((p) => {
                        const next = new Set(p);
                        if (e.target.checked) next.add(o.key);
                        else next.delete(o.key);
                        return next;
                      })
                    }
                  />{" "}
                  {t("authoring:objectives.pick", { n: n + 1 })}
                </label>
                <Button variant="secondary" onPress={() => setItems((l) => l.filter((i) => i.key !== o.key))}>
                  {t("authoring:objectives.remove", { n: n + 1 })}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <div className={styles.row}>
          <Button
            variant="secondary"
            onPress={() =>
              setItems((l) => [
                ...l,
                { key: crypto.randomUUID(), label: "", description: "", evidence: [], sectionIds: [] },
              ])
            }
          >
            {t("authoring:objectives.add")}
          </Button>
          <Button variant="secondary" onPress={merge} isDisabled={picked.size < 2}>
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
    </Card>
  );
}

// ── Blueprint ────────────────────────────────────────────────────────

const num = (s: string) => Math.max(0, Math.floor(Number(s) || 0));

function BlueprintSection({ detail, refresh }: { detail: SessionDetail; refresh: Refresh }) {
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
    <Card title={t("authoring:blueprint.title")}>
      <p>{t("authoring:blueprint.help")}</p>
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
    </Card>
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

function GenerateSection({ detail, refresh }: { detail: SessionDetail; refresh: Refresh }) {
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
  return (
    <Card title={t("authoring:generate.title")}>
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
      {detail.blueprint === null && status === "draft" ? <p>{t("authoring:generate.needsBlueprint")}</p> : null}
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
    </Card>
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
  return (
    <>
      <h1>{detail.session.title}</h1>
      <p>
        {t("authoring:session.summary", {
          type: t(`authoring:testTypes.${detail.session.testType}`),
          status: t(`authoring:session.status.${detail.session.status}`),
        })}{" "}
        <Link to="/authoring">{t("authoring:session.back")}</Link>
      </p>
      <ScopeSection detail={detail} refresh={refresh} />
      <ObjectivesSection detail={detail} refresh={refresh} />
      <BlueprintSection detail={detail} refresh={refresh} />
      <GenerateSection detail={detail} refresh={refresh} />
      {detail.questions.length > 0 ? <ReviewSection detail={detail} refresh={refresh} /> : null}
      {detail.questions.length > 0 ? <PublishSection detail={detail} /> : null}
    </>
  );
}

export function AuthoringSessionPage({ sessionId }: { sessionId: string }) {
  return <RequireRole minRole="proctor">{() => <Session sessionId={sessionId} />}</RequireRole>;
}
