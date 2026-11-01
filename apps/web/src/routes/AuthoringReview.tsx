import type { DraftStatus, LayerResult } from "@gem/shared";
import {
  authoringQuestionAcceptFix,
  authoringQuestionChooseProgram,
  authoringQuestionHistory,
  authoringQuestionPatch,
  authoringQuestionReclassify,
  authoringQuestionVerify,
  authoringRevise,
  type DraftView,
  type QuestionEdit,
  type SessionDetail,
  sourcesChunks,
} from "@gem/shared/contracts";
import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { formatDateTime } from "../format.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, Select, TextField } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Passage } from "../ui/Passage.tsx";
import styles from "./Authoring.module.css";

type Refresh = () => Promise<unknown>;
type Chunk = { text: string; label: string; path: string; sourceId: string; revision: number };

const OUTCOME_CLASS = { pass: styles.good, warn: styles.warn, fail: styles.bad } as const;
const OUTCOME_SYMBOL = { pass: "✓", warn: "!", fail: "✕" } as const;

/** A badge says it in words as well as colour and a symbol (SPEC §1.3). */
function Badge({ result }: { result: LayerResult }) {
  const { t } = useTranslation();
  return (
    <li className={`${styles.badge} ${OUTCOME_CLASS[result.outcome]}`}>
      <span aria-hidden="true">{OUTCOME_SYMBOL[result.outcome]} </span>
      {t(`authoring:layers.${result.layer}`)}: {t(`authoring:outcomes.${result.outcome}`)}
    </li>
  );
}

function Issues({ results }: { results: LayerResult[] }) {
  const { t } = useTranslation();
  const lines = results.flatMap((r) => [
    ...r.issues.map((i) => ({
      key: `${r.layer}:${i.code}:${JSON.stringify(i.params)}`,
      severity: i.severity,
      text: `${t(`authoring:layers.${r.layer}`)}: ${t(`authoring:issues.${i.code}`, i.params)}`,
    })),
    ...(r.reason && r.reason !== "ok" && r.outcome !== "pass"
      ? [
          {
            key: `${r.layer}:${r.reason}`,
            severity: r.outcome,
            text: `${t(`authoring:layers.${r.layer}`)}: ${t(`import:verify.reasons.${r.reason}`)}`,
          },
        ]
      : []),
  ]);
  if (lines.length === 0) return null;
  return (
    <ul>
      {lines.map((l) => (
        <li key={l.key} className={l.severity === "fail" ? styles.bad : styles.warn}>
          <span aria-hidden="true">{l.severity === "fail" ? "✕ " : "! "}</span>
          {t(`authoring:outcomes.${l.severity === "fail" ? "fail" : "warn"}`)}: {l.text}
        </li>
      ))}
    </ul>
  );
}

function CheckDetails({ q }: { q: DraftView }) {
  const { t } = useTranslation();
  const l7 = q.content.l7;
  if (!l7) return null;
  const program = (name: string, p: NonNullable<typeof l7.author>) => (
    <div>
      <h5>{name}</h5>
      <pre className={styles.program}>{p.program}</pre>
      <p>
        {t("authoring:l7.status", { status: p.status })}
        {p.result ? ` · ${t("authoring:l7.result", { value: p.result.text })}` : null}
      </p>
    </div>
  );
  return (
    <details>
      <summary>{t("authoring:l7.summary", { flow: t(`authoring:l7.flows.${l7.flow}`) })}</summary>
      {l7.author ? program(t("authoring:l7.author"), l7.author) : null}
      {l7.blind ? program(t("authoring:l7.blind"), l7.blind) : null}
      {l7.suggestedFix ? <p>{t("authoring:l7.suggested", { value: l7.suggestedFix })}</p> : null}
    </details>
  );
}

function History({ id }: { id: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["authoring", "history", id],
    enabled: open,
    queryFn: () => api.call(authoringQuestionHistory, { params: { id } }),
  });
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{t("authoring:history.title")}</summary>
      <ErrorMessage error={query.error} />
      {query.data ? (
        <ol>
          {query.data.events.map((e) => (
            <li key={e.id}>
              {t(`authoring:events.${e.kind}`)} · {e.actorName ?? t("authoring:history.system")} ·{" "}
              {formatDateTime(e.at)}
              {e.note ? ` · ${t("authoring:history.note", { note: e.note })}` : null}
            </li>
          ))}
        </ol>
      ) : null}
    </details>
  );
}

function EditForm({
  q,
  onSave,
  onCancel,
}: {
  q: DraftView;
  onSave: (edit: QuestionEdit) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const c = q.content;
  const [question, setQuestion] = useState(c.question ?? c.template);
  const [options, setOptions] = useState(c.options ?? []);
  const [answer, setAnswer] = useState(c.correctAnswer ?? "");
  const [explanation, setExplanation] = useState(c.explanation);
  const typed = c.options === null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          ...(question !== (c.question ?? c.template) ? { question } : {}),
          ...(!typed && JSON.stringify(options) !== JSON.stringify(c.options)
            ? { options: options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })) }
            : {}),
          ...(typed && answer !== (c.correctAnswer ?? "") && answer.trim() !== "" ? { correctAnswer: answer } : {}),
          ...(explanation !== c.explanation ? { explanation } : {}),
        });
      }}
    >
      <TextField label={t("authoring:edit.question")} value={question} onChange={setQuestion} multiline rows={3} />
      {typed ? (
        <TextField label={t("authoring:edit.answer")} value={answer} onChange={setAnswer} />
      ) : (
        <fieldset>
          <legend>{t("authoring:edit.options")}</legend>
          {options.map((o, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list has no ids, and its length doesn't change here.
            <div key={i} className={styles.row}>
              <TextField
                label={t("authoring:edit.option", { n: i + 1 })}
                value={o.text}
                onChange={(text) => setOptions((l) => l.map((x, n) => (n === i ? { ...x, text } : x)))}
              />
              <label>
                <input
                  type="checkbox"
                  checked={o.isCorrect}
                  onChange={(e) =>
                    setOptions((l) =>
                      l.map((x, n) =>
                        n === i
                          ? { ...x, isCorrect: e.target.checked }
                          : c.type === "multi_choice"
                            ? x
                            : { ...x, isCorrect: e.target.checked ? false : x.isCorrect },
                      ),
                    )
                  }
                />{" "}
                {t("authoring:edit.correct", { n: i + 1 })}
              </label>
            </div>
          ))}
        </fieldset>
      )}
      <TextField
        label={t("authoring:edit.explanation")}
        value={explanation}
        onChange={setExplanation}
        multiline
        rows={2}
      />
      <div className={styles.row}>
        <Button type="submit">{t("authoring:edit.save")}</Button>
        <Button variant="secondary" onPress={onCancel}>
          {t("authoring:edit.cancel")}
        </Button>
      </div>
    </form>
  );
}

function QuestionCard({
  q,
  detail,
  chunks,
  refresh,
}: {
  q: DraftView;
  detail: SessionDetail;
  chunks: Map<string, Chunk>;
  refresh: Refresh;
}) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [fix, setFix] = useState(false);
  const [reclassify, setReclassify] = useState(false);
  const [why, setWhy] = useState("");
  const done = (key: string) => async () => {
    await refresh();
    announce(t(`authoring:review.done.${key}`, { n: q.position }));
  };
  const patch = useMutation({
    mutationFn: (body: { status?: DraftStatus; edit?: QuestionEdit; note?: string }) =>
      api.call(authoringQuestionPatch, { params: { id: q.id }, body }),
  });
  const verify = useMutation({
    mutationFn: () => api.call(authoringQuestionVerify, { params: { id: q.id }, query: {} }),
    onSuccess: done("rerun"),
  });
  const acceptFix = useMutation({
    mutationFn: () => api.call(authoringQuestionAcceptFix, { params: { id: q.id }, body: { confirm: true } }),
    onSuccess: async () => {
      setFix(false);
      await done("fix")();
    },
  });
  const choose = useMutation({
    mutationFn: (which: "author" | "blind") =>
      api.call(authoringQuestionChooseProgram, { params: { id: q.id }, body: { which } }),
    onSuccess: done("chose"),
  });
  const reclass = useMutation({
    mutationFn: () => api.call(authoringQuestionReclassify, { params: { id: q.id }, body: { note: why } }),
    onSuccess: async () => {
      setReclassify(false);
      setWhy("");
      await done("reclassified")();
    },
  });
  const revise = useMutation({
    mutationFn: () =>
      api.call(authoringRevise, {
        params: { id: detail.session.id },
        body: { questions: [{ id: q.id, ...(note.trim() ? { note } : {}) }] },
      }),
    onSuccess: async () => {
      setNote("");
      await done("regenerating")();
    },
  });
  const status = (s: DraftStatus, key: string) => patch.mutate({ status: s }, { onSuccess: done(key) });

  const c = q.content;
  const locked = q.status === "locked";
  const evidence = c.evidence.flatMap((e) => {
    const chunk = chunks.get(e.chunkId);
    return chunk ? [{ e, chunk }] : [];
  });
  const objectives = c.objectiveIds
    .map((id) => detail.objectives.find((o) => o.id === id)?.label)
    .filter((l): l is string => l !== undefined);
  const l7 = c.l7;
  const error = patch.error ?? verify.error ?? acceptFix.error ?? choose.error ?? reclass.error ?? revise.error;
  return (
    <li className={styles.question} aria-labelledby={`q-${q.id}`}>
      <h3 id={`q-${q.id}`}>
        {t("authoring:review.heading", { n: q.position, topic: c.topic })}{" "}
        <span className={styles.muted}>{t(`authoring:question.status.${q.status}`)}</span>
      </h3>
      <ul className={styles.badges} aria-label={t("authoring:review.checks")}>
        {q.validations.map((v) => (
          <Badge key={v.layer} result={v} />
        ))}
      </ul>
      {c.l7Pending ? <p role="status">{t("authoring:review.checking")}</p> : null}
      <div className={styles.grid}>
        <div>
          <Markdown>{c.question ?? c.template}</Markdown>
          {c.computable && c.question === null ? (
            <p className={styles.muted}>{t("authoring:review.template")}</p>
          ) : null}
          {c.options ? (
            <ul className={styles.options}>
              {c.options.map((o) => (
                <li key={o.text} className={o.isCorrect ? styles.correct : undefined}>
                  <Markdown inline>{o.text}</Markdown>
                  {o.isCorrect ? <span> ({t("authoring:review.correct")})</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {c.options === null ? (
            <p>
              {c.correctAnswer === null
                ? t("authoring:review.noAnswer")
                : t("authoring:review.answer", { answer: c.correctAnswer })}
            </p>
          ) : null}
          <p className={styles.muted}>{t("authoring:review.explanation", { text: c.explanation })}</p>
          <p className={styles.muted}>
            {t("authoring:review.objectives", { list: objectives.join(", ") })} ·{" "}
            {t(`authoring:review.provenance.${c.provenance}`)}
          </p>
          {q.creatorNote ? <p>{t("authoring:review.creatorNote", { note: q.creatorNote })}</p> : null}
          <Issues results={q.validations} />
          <CheckDetails q={q} />
        </div>
        <div>
          <h4>{t("authoring:review.passages")}</h4>
          {evidence.length === 0 ? <p>{t("authoring:review.noPassages")}</p> : null}
          <ul className={styles.sources}>
            {evidence.map(({ e, chunk }) => (
              <li key={`${e.chunkId}:${e.quote}`}>
                <p className={styles.muted}>
                  <Link
                    to="/sources/$sourceId"
                    params={{ sourceId: chunk.sourceId }}
                    search={{ revision: chunk.revision, chunk: e.chunkId, quote: e.quote }}
                  >
                    {t("authoring:review.citation", { label: chunk.label, path: chunk.path })}
                  </Link>
                </p>
                <Passage text={chunk.text} quote={e.quote} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      {editing ? (
        <EditForm
          q={q}
          onCancel={() => setEditing(false)}
          onSave={(edit) =>
            patch.mutate(
              { edit },
              {
                onSuccess: async () => {
                  setEditing(false);
                  await done("edited")();
                },
              },
            )
          }
        />
      ) : (
        <div className={styles.row}>
          {q.status === "accepted" || q.status === "locked" ? (
            <Button variant="secondary" onPress={() => status("proposed", "reopened")}>
              {t("authoring:review.reopen")}
            </Button>
          ) : (
            <Button onPress={() => status("accepted", "accepted")} isDisabled={q.blocked || patch.isPending}>
              {t("authoring:review.accept")}
            </Button>
          )}
          {q.status !== "locked" && q.status !== "rejected" ? (
            <Button variant="secondary" onPress={() => status("rejected", "rejected")}>
              {t("authoring:review.reject")}
            </Button>
          ) : null}
          {q.status === "accepted" ? (
            <Button variant="secondary" onPress={() => status("locked", "locked")}>
              {t("authoring:review.lock")}
            </Button>
          ) : null}
          <Button variant="secondary" onPress={() => setEditing(true)} isDisabled={locked}>
            {t("authoring:review.edit")}
          </Button>
          <Button variant="secondary" onPress={() => verify.mutate()} isDisabled={locked || verify.isPending}>
            {t("authoring:review.rerun")}
          </Button>
          {l7?.suggestedFix ? (
            <Button variant="secondary" onPress={() => setFix(true)} isDisabled={locked}>
              {t("authoring:review.acceptFix", { value: l7.suggestedFix })}
            </Button>
          ) : null}
          {l7?.outcome === "disagree" && l7.author?.result && l7.blind?.result ? (
            <>
              <Button variant="secondary" onPress={() => choose.mutate("author")}>
                {t("authoring:review.useAuthor", { value: l7.author.result.text })}
              </Button>
              <Button variant="secondary" onPress={() => choose.mutate("blind")}>
                {t("authoring:review.useBlind", { value: l7.blind.result.text })}
              </Button>
            </>
          ) : null}
          {c.computable ? (
            <Button variant="secondary" onPress={() => setReclassify(true)} isDisabled={locked}>
              {t("authoring:review.reclassify")}
            </Button>
          ) : null}
        </div>
      )}
      {q.blocked && q.status !== "accepted" && q.status !== "locked" ? (
        <p className={styles.muted}>{t("authoring:review.blocked")}</p>
      ) : null}
      <div className={styles.row}>
        <TextField
          label={t("authoring:review.noteLabel", { n: q.position })}
          value={note}
          onChange={setNote}
          isDisabled={locked}
        />
        <Button variant="secondary" onPress={() => revise.mutate()} isDisabled={locked || revise.isPending}>
          {t("authoring:review.regenerate")}
        </Button>
      </div>
      <ErrorMessage error={error} />
      <History id={q.id} />
      <ConfirmDialog
        isOpen={fix}
        onOpenChange={setFix}
        title={t("authoring:fixDialog.title")}
        confirmLabel={t("authoring:fixDialog.confirm")}
        cancelLabel={t("authoring:dialog.cancel")}
        onConfirm={() => acceptFix.mutate()}
        isPending={acceptFix.isPending}
      >
        <p>{t("authoring:fixDialog.body", { from: c.correctAnswer ?? "", to: l7?.suggestedFix ?? "" })}</p>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={reclassify}
        onOpenChange={setReclassify}
        title={t("authoring:reclassifyDialog.title")}
        confirmLabel={t("authoring:reclassifyDialog.confirm")}
        cancelLabel={t("authoring:dialog.cancel")}
        onConfirm={() => reclass.mutate()}
        isPending={reclass.isPending || why.trim() === ""}
      >
        <p>{t("authoring:reclassifyDialog.body")}</p>
        <TextField label={t("authoring:reclassifyDialog.note")} value={why} onChange={setWhy} multiline rows={2} />
      </ConfirmDialog>
    </li>
  );
}

type Filter = "all" | "fail" | "warn" | "pass";

export function ReviewSection({ detail, refresh }: { detail: SessionDetail; refresh: Refresh }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");
  const [objective, setObjective] = useState("all");
  const loaded = useQueries({
    queries: detail.sources.map((s) => ({
      queryKey: ["source", s.sourceId, "chunks", s.revisionNumber],
      queryFn: () => api.call(sourcesChunks, { params: { id: s.sourceId }, query: { revision: s.revisionNumber } }),
    })),
  });
  const chunks = new Map<string, Chunk>();
  for (const [i, result] of loaded.entries()) {
    const s = detail.sources[i];
    if (!s) continue;
    for (const c of result.data?.chunks ?? []) {
      chunks.set(c.id, {
        text: c.text,
        label: s.citationLabel,
        path: c.headingPath.join(" › "),
        sourceId: s.sourceId,
        revision: s.revisionNumber,
      });
    }
  }
  const worst = (q: DraftView) =>
    q.validations.some((v) => v.outcome === "fail") || q.blocked
      ? "fail"
      : q.validations.some((v) => v.outcome === "warn")
        ? "warn"
        : "pass";
  const shown = detail.questions.filter(
    (q) =>
      (filter === "all" || worst(q) === filter) && (objective === "all" || q.content.objectiveIds.includes(objective)),
  );
  const count = (s: DraftStatus) => detail.questions.filter((q) => q.status === s).length;
  return (
    <Card title={t("authoring:review.title")}>
      <p aria-live="polite">
        {t("authoring:review.summary", {
          total: detail.questions.length,
          accepted: count("accepted") + count("locked"),
          rejected: count("rejected"),
          open: count("proposed"),
        })}
      </p>
      <div className={styles.row}>
        <Select
          label={t("authoring:review.filter")}
          selectedKey={filter}
          onSelectionChange={(k) => setFilter(k as Filter)}
          options={(["all", "fail", "warn", "pass"] as const).map((id) => ({
            id,
            label: t(`authoring:review.filters.${id}`),
          }))}
        />
        <Select
          label={t("authoring:review.byObjective")}
          selectedKey={objective}
          onSelectionChange={setObjective}
          options={[
            { id: "all", label: t("authoring:review.filters.all") },
            ...detail.objectives.map((o) => ({ id: o.id, label: o.label })),
          ]}
        />
      </div>
      <p aria-live="polite" className={styles.muted}>
        {t("authoring:review.showing", { shown: shown.length, total: detail.questions.length })}
      </p>
      <ul className={styles.questions}>
        {shown.map((q) => (
          <QuestionCard key={q.id} q={q} detail={detail} chunks={chunks} refresh={refresh} />
        ))}
      </ul>
    </Card>
  );
}
