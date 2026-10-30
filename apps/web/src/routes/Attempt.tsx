import { effectiveType, type Question } from "@gem/shared";
import {
  type PracticeAnswer,
  type PracticeAttemptDetail,
  type PracticeResponse,
  practiceGet,
  practiceSaveResponse,
  practiceSubmit,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Checkbox, CheckboxGroup, Radio, RadioGroup, ToggleButton } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api, contractUrl } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatClock, formatNumber } from "../format.ts";
import { hasAnswer, loadDraft, QuestionClock, saveDraft } from "../practice/session.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { uniqueKeys } from "../ui/keys.ts";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Feedback } from "./Feedback.tsx";
import styles from "./Practice.module.css";

type Detail = PracticeAttemptDetail;
type SaveBody = { answer?: PracticeAnswer; check?: true; flagged?: boolean; timeSpentMs?: number };

export const practiceKey = (attemptId: string) => ["practice", "attempt", attemptId] as const;

const isAnswered = (r: PracticeResponse | undefined) => !!r?.autoResult;

/** The answer control: a real radio group, checkbox group or text field (SPEC §1.3). */
function AnswerInput({
  question,
  value,
  onChange,
  response,
  promptId,
}: {
  question: Question;
  value: PracticeAnswer | null;
  onChange: (v: PracticeAnswer) => void;
  response: PracticeResponse;
  promptId: string;
}) {
  const { t } = useTranslation();
  const type = effectiveType(question);
  const checked = isAnswered(response);
  const correct = new Set(
    type === "multi_choice" ? (question.correctAnswers ?? [question.correctAnswer]) : [question.correctAnswer],
  );
  const given = new Set(Array.isArray(value) ? value : value ? [value] : []);

  const badges = (o: string) =>
    checked ? (
      <span className={styles.badges}>
        {given.has(o) ? <span className={styles.badgeYours}>{t("practice:answer.yours")}</span> : null}
        {correct.has(o) ? <span className={styles.badgeCorrect}>{t("practice:answer.correct")}</span> : null}
      </span>
    ) : null;

  if (question.options && (type === "single_choice" || type === "true_false")) {
    const keys = uniqueKeys(question.options);
    return (
      <RadioGroup
        className={styles.choices}
        aria-labelledby={promptId}
        value={typeof value === "string" ? value : null}
        onChange={onChange}
        isReadOnly={checked}
      >
        {question.options.map((o, i) => (
          <Radio key={keys[i]} value={o} className={styles.choice}>
            <span className={styles.radio} aria-hidden="true" />
            <span className={styles.choiceText}>
              <Markdown inline>{o}</Markdown>
            </span>
            {badges(o)}
          </Radio>
        ))}
      </RadioGroup>
    );
  }
  if (question.options && type === "multi_choice") {
    const keys = uniqueKeys(question.options);
    return (
      <CheckboxGroup
        className={styles.choices}
        aria-labelledby={promptId}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        isReadOnly={checked}
      >
        <p className={styles.hint}>{t("practice:answer.selectAll")}</p>
        {question.options.map((o, i) => (
          <Checkbox key={keys[i]} value={o} className={styles.choice}>
            <span className={styles.checkbox} aria-hidden="true" />
            <span className={styles.choiceText}>
              <Markdown inline>{o}</Markdown>
            </span>
            {badges(o)}
          </Checkbox>
        ))}
      </CheckboxGroup>
    );
  }
  return (
    <TextField
      label={type === "numeric" ? t("practice:answer.numberLabel") : t("practice:answer.textLabel")}
      description={type === "numeric" ? t("practice:answer.numberHelp") : undefined}
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
      isReadOnly={checked}
      inputProps={type === "numeric" ? { inputMode: "decimal" } : {}}
    />
  );
}

function Attempt({ attemptId }: { attemptId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { announce } = useLive();
  const query = useQuery({
    queryKey: practiceKey(attemptId),
    queryFn: () => api.call(practiceGet, { params: { id: attemptId } }),
  });
  const detail = query.data;
  useDocumentTitle(
    detail ? t("practice:attempt.documentTitle", { title: detail.quiz.title }) : t("practice:attempt.title"),
  );

  const [index, setIndex] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, PracticeAnswer | null>>({});
  const [now, setNow] = useState(() => Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const clock = useRef(new QuestionClock());
  const spent = useRef(new Map<number, number>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  const questions = detail?.questions ?? [];
  const total = questions.length;
  const current = index === null ? undefined : questions[index];
  const responseOf = useCallback((qid: number) => detail?.responses.find((r) => r.questionId === qid), [detail]);
  // Read by the clock effect, which must only rerun when the question changes (not on every save).
  const responseOfRef = useRef(responseOf);
  responseOfRef.current = responseOf;

  const setResponse = (r: PracticeResponse) =>
    qc.setQueryData<Detail>(practiceKey(attemptId), (d) =>
      d ? { ...d, responses: d.responses.map((x) => (x.questionId === r.questionId ? r : x)) } : d,
    );

  const save = useMutation({
    mutationFn: ({ questionId, body }: { questionId: number; body: SaveBody }) =>
      api.call(practiceSaveResponse, { params: { id: attemptId, questionId }, body }),
    onSuccess: (res) => setResponse(res.response),
  });

  /** Cumulative time on the question shown now, remembered so a pending save can't make it go back. */
  const takeTime = useCallback(() => {
    const qid = clock.current.current;
    if (qid === null) return undefined;
    const ms = clock.current.cumulative();
    spent.current.set(qid, Math.max(spent.current.get(qid) ?? 0, ms));
    return ms;
  }, []);

  // Open the first unanswered question once (resume, P1.md §5), and restore typed drafts.
  useEffect(() => {
    if (!detail || index !== null) return;
    const first = detail.questions.findIndex((q) => !isAnswered(detail.responses.find((r) => r.questionId === q.id)));
    const restored: Record<number, PracticeAnswer | null> = {};
    for (const q of detail.questions) restored[q.id] = loadDraft(attemptId, q.id);
    setDrafts(restored);
    setIndex(first === -1 ? 0 : first);
  }, [detail, index, attemptId]);

  // Start the question clock whenever the displayed question changes.
  const currentId = current?.id;
  useEffect(() => {
    if (currentId === undefined) return;
    const base = Math.max(spent.current.get(currentId) ?? 0, responseOfRef.current(currentId)?.timeSpentMs ?? 0);
    clock.current.start(currentId, base);
    if (moved.current) headingRef.current?.focus();
  }, [currentId]);

  // Pause while the page is hidden; on leaving the page, send the time with a keepalive request.
  useEffect(() => {
    const onVisibility = () => clock.current.visibilityChanged(document.visibilityState === "visible");
    const onPageHide = () => {
      const qid = clock.current.current;
      const ms = takeTime();
      if (qid === null || ms === undefined) return;
      void fetch(contractUrl(practiceSaveResponse, { params: { id: attemptId, questionId: qid } }), {
        method: "PUT",
        credentials: "same-origin",
        keepalive: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeSpentMs: ms }),
      }).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [attemptId, takeTime]);

  // The soft timer: elapsed time since the start, never ends the attempt (WCAG 2.2.1).
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const submit = useMutation({
    mutationFn: async () => {
      // Typed but unchecked answers are saved first; the server grades them at submit.
      if (detail) {
        for (const q of detail.questions) {
          const draft = drafts[q.id];
          if (!isAnswered(responseOf(q.id)) && hasAnswer(draft)) {
            await api.call(practiceSaveResponse, {
              params: { id: attemptId, questionId: q.id },
              body: { answer: draft },
            });
          }
        }
      }
      const qid = clock.current.current;
      const ms = takeTime();
      if (qid !== null && ms !== undefined) {
        await api.call(practiceSaveResponse, { params: { id: attemptId, questionId: qid }, body: { timeSpentMs: ms } });
      }
      return api.call(practiceSubmit, { params: { id: attemptId } });
    },
    onSuccess: async () => {
      for (const q of questions) saveDraft(attemptId, q.id, null);
      await qc.invalidateQueries({ queryKey: ["practice"] });
      announce(t("practice:submit.done"));
      await navigate({ to: "/practice/attempts/$attemptId/results", params: { attemptId } });
    },
    onError: (e) => announce(errorText(t, e)),
  });

  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (query.error || !detail) return <ErrorMessage error={query.error} />;
  if (detail.attempt.status === "submitted" && !submit.isPending && !submit.isSuccess) {
    return <Navigate to="/practice/attempts/$attemptId/results" params={{ attemptId }} />;
  }
  if (index === null || !current) return <p>{t("common:loading")}</p>;

  const response = responseOf(current.id) as PracticeResponse;
  const checked = isAnswered(response);
  const value = checked ? response.answer : (drafts[current.id] ?? null);
  const answeredCount = detail.responses.filter(isAnswered).length;
  const unanswered = questions.filter((q) => !isAnswered(responseOf(q.id)) && !hasAnswer(drafts[q.id])).length;
  const elapsed = now - Date.parse(detail.attempt.startedAt);
  const promptId = `question-${current.id}-prompt`;

  const goTo = (i: number) => {
    if (i === index || i < 0 || i >= total) return;
    const ms = takeTime();
    if (ms !== undefined) save.mutate({ questionId: current.id, body: { timeSpentMs: ms } });
    moved.current = true;
    setIndex(i);
    announce(t("practice:attempt.position", { n: formatNumber(i + 1), total: formatNumber(total) }));
  };

  const onChange = (v: PracticeAnswer) => {
    setDrafts((d) => ({ ...d, [current.id]: v }));
    saveDraft(attemptId, current.id, v);
  };

  const check = () => {
    if (!hasAnswer(value)) return;
    save.mutate(
      { questionId: current.id, body: { answer: value, check: true, timeSpentMs: takeTime() } },
      {
        onSuccess: (res) => {
          saveDraft(attemptId, current.id, null);
          const f = res.feedback;
          if (f) announce(t(`practice:outcome.${f.outcome}`));
          window.setTimeout(() => feedbackRef.current?.focus(), 0);
        },
        onError: (e) => announce(errorText(t, e)),
      },
    );
  };

  const toggleFlag = (flagged: boolean) => {
    save.mutate(
      { questionId: current.id, body: { flagged, timeSpentMs: takeTime() } },
      {
        onSuccess: () => announce(flagged ? t("practice:flag.flagged") : t("practice:flag.unflagged")),
        onError: (e) => announce(errorText(t, e)),
      },
    );
  };

  return (
    <>
      <h1>{detail.quiz.title}</h1>
      <div className={styles.statusBar}>
        <p className={styles.progress}>
          {t("practice:attempt.answeredCount", { answered: formatNumber(answeredCount), total: formatNumber(total) })}
        </p>
        <p className={styles.timer}>
          <span id="elapsed-label">{t("practice:timer.label")}</span>{" "}
          {/* role="timer" is not announced on every tick (aria-live off); the label is always readable. */}
          <span role="timer" aria-live="off" aria-labelledby="elapsed-label" className={styles.timerValue}>
            {formatClock(elapsed)}
          </span>
        </p>
      </div>

      <section className={styles.questionCard} aria-labelledby="question-heading">
        <h2 id="question-heading" ref={headingRef} tabIndex={-1} className={styles.questionHeading}>
          {t("practice:attempt.position", { n: formatNumber(index + 1), total: formatNumber(total) })}
        </h2>
        <p className={styles.questionMeta}>
          {t("practice:attempt.meta", { topic: current.topic, type: t(`tests:types.${effectiveType(current)}`) })}
        </p>
        <div id={promptId} className={styles.prompt}>
          <Markdown>{current.question}</Markdown>
        </div>

        {/* Keyed: a radio group kept across questions keeps its roving tab stop on an option that's gone. */}
        <AnswerInput
          key={current.id}
          question={current}
          value={value}
          onChange={onChange}
          response={response}
          promptId={promptId}
        />

        {checked ? (
          <Feedback ref={feedbackRef} attemptId={attemptId} question={current} response={response} editable />
        ) : (
          <Button onPress={check} isDisabled={!hasAnswer(value) || save.isPending}>
            {t("practice:check")}
          </Button>
        )}
        <ErrorMessage error={save.error} />

        <div className={styles.questionActions}>
          <ToggleButton
            className={styles.flag}
            isSelected={response.flagged}
            onChange={toggleFlag}
            isDisabled={save.isPending}
          >
            <span aria-hidden="true">⚑</span> {t("practice:flag.label")}
          </ToggleButton>
          <Button variant="secondary" onPress={() => goTo(index - 1)} isDisabled={index === 0}>
            {t("practice:attempt.previous")}
          </Button>
          <Button variant="secondary" onPress={() => goTo(index + 1)} isDisabled={index === total - 1}>
            {t("practice:attempt.next")}
          </Button>
        </div>
      </section>

      <nav className={styles.navigator} aria-label={t("practice:nav.label")}>
        <h2 className={styles.navTitle}>{t("practice:nav.title")}</h2>
        <ol className={styles.navList}>
          {questions.map((q, i) => {
            const r = responseOf(q.id);
            const answered = isAnswered(r);
            const flagged = !!r?.flagged;
            const label = [
              t("practice:nav.item", { n: formatNumber(i + 1) }),
              answered ? t("practice:nav.answered") : t("practice:nav.unanswered"),
              flagged ? t("practice:nav.flagged") : null,
            ]
              .filter(Boolean)
              .join(", ");
            return (
              <li key={q.id}>
                <button
                  type="button"
                  className={[
                    styles.navItem,
                    answered ? styles.navAnswered : "",
                    i === index ? styles.navCurrent : "",
                  ].join(" ")}
                  aria-label={label}
                  aria-current={i === index ? "step" : undefined}
                  onClick={() => goTo(i)}
                >
                  <span>{formatNumber(i + 1)}</span>
                  <span className={styles.navMarks} aria-hidden="true">
                    {answered ? "✓" : ""}
                    {flagged ? "⚑" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className={styles.legend}>{t("practice:nav.legend")}</p>
      </nav>

      <div className={styles.submitBar}>
        <Button onPress={() => setConfirmOpen(true)} isDisabled={submit.isPending}>
          {t("practice:submit.open")}
        </Button>
        <ErrorMessage error={submit.error} />
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("practice:submit.title")}
        confirmLabel={t("practice:submit.confirm")}
        cancelLabel={t("practice:submit.cancel")}
        onConfirm={() => {
          setConfirmOpen(false);
          submit.mutate();
        }}
        isPending={submit.isPending}
      >
        <p>
          {unanswered > 0
            ? t("practice:submit.unanswered", { count: unanswered, n: formatNumber(unanswered) })
            : t("practice:submit.allAnswered")}
        </p>
        <p>{t("practice:submit.final")}</p>
      </ConfirmDialog>
    </>
  );
}

export function AttemptPage({ attemptId }: { attemptId: string }) {
  return <RequireRole minRole="proctor">{() => <Attempt attemptId={attemptId} />}</RequireRole>;
}
