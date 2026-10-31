import type { ImportReport, NormalizationFix, QuizIssue, VerificationItem } from "@gem/shared";
import { IMPORT_MAX_BYTES, type ImportPreview, importCreate, importPreview } from "@gem/shared/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type UIEvent, useCallback, useId, useMemo, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { uniqueKeys } from "../ui/keys.ts";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { type DisplayQuestion, QuestionList } from "../ui/QuestionList.tsx";
import styles from "./Import.module.css";
import { type FixChoices, VerifyPanel } from "./ImportVerify.tsx";

type T = (key: string, params?: Record<string, unknown>) => string;

function pathLabel(t: T, path: (string | number)[], params: Record<string, string | number>): string {
  if (path[0] === "questions" && typeof path[1] === "number") {
    const id = params.id ?? path[1] + 1;
    const field = path.slice(2).join(".");
    return field ? t("import:report.questionField", { id, field }) : t("import:report.question", { id });
  }
  return path.length > 0 ? path.join(".") : t("import:report.wholeQuiz");
}

function IssueList({ issues, tone }: { issues: QuizIssue[]; tone: "error" | "warning" }) {
  const { t } = useTranslation();
  const keys = uniqueKeys(issues.map((i) => JSON.stringify([i.code, i.path, i.params])));
  return (
    <ul className={tone === "error" ? styles.errors : styles.warnings}>
      {issues.map((issue, i) => (
        <li key={keys[i]}>
          <strong>{pathLabel(t, issue.path, issue.params)}</strong>
          {": "}
          {t(`import:issues.${issue.code}`, issue.params)}
        </li>
      ))}
    </ul>
  );
}

function FixList({ fixes }: { fixes: NormalizationFix[] }) {
  const { t } = useTranslation();
  const keys = uniqueKeys(fixes.map((f) => JSON.stringify([f.code, f.path, f.params])));
  return (
    <ul className={styles.fixes}>
      {fixes.map((fix, i) => (
        <li key={keys[i]} className={fix.severity === "warning" ? styles.fixWarning : undefined}>
          {fix.severity === "warning" ? <strong>{t("import:report.warningLabel")} </strong> : null}
          {fix.path.length > 0 ? <span className={styles.fixPath}>{pathLabel(t, fix.path, fix.params)}: </span> : null}
          {t(`import:fixes.${fix.code}`, fix.params)}
        </li>
      ))}
    </ul>
  );
}

function Report({ report }: { report: ImportReport }) {
  const { t } = useTranslation();
  return (
    <Card title={t("import:report.title")}>
      <p className={report.canSave ? styles.ok : styles.blocked}>
        {report.canSave ? t("import:report.canSave") : t("import:report.blocked", { count: report.errors.length })}
      </p>
      <p>
        {t("import:report.summary", {
          questions: formatNumber(report.questionCount),
          errors: report.errors.length,
          warnings: report.warnings.length,
          fixes: report.fixes.length,
        })}
      </p>
      {report.errors.length > 0 ? (
        <>
          <h3>{t("import:report.errors", { count: report.errors.length })}</h3>
          <IssueList issues={report.errors} tone="error" />
        </>
      ) : null}
      {report.warnings.length > 0 ? (
        <>
          <h3>{t("import:report.warnings", { count: report.warnings.length })}</h3>
          <IssueList issues={report.warnings} tone="warning" />
        </>
      ) : null}
      {report.fixes.length > 0 ? (
        <details className={styles.fixDetails} open={report.fixes.some((f) => f.code !== "type_inferred")}>
          <summary>{t("import:report.fixes", { count: report.fixes.length })}</summary>
          <FixList fixes={report.fixes} />
        </details>
      ) : (
        <p>{t("import:report.noFixes")}</p>
      )}
    </Card>
  );
}

/** JSON editor: a textarea with line numbers (P0.md §5, "Import edit UI"). */
function JsonEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const gutter = useRef<HTMLPreElement>(null);
  const descriptionId = useId();
  const lines = useMemo(() => value.split("\n").length, [value]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);
  const onScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
  };
  return (
    <div className={styles.editor}>
      <label htmlFor={`${descriptionId}-input`} className={styles.editorLabel}>
        {t("import:editor.label")}
      </label>
      <p id={descriptionId} className={styles.editorHelp}>
        {t("import:editor.help", { lines })}
      </p>
      <div className={styles.editorBody}>
        <pre ref={gutter} className={styles.gutter} aria-hidden="true">
          {numbers}
        </pre>
        <textarea
          id={`${descriptionId}-input`}
          aria-describedby={descriptionId}
          className={styles.code}
          value={value}
          spellCheck={false}
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={onScroll}
        />
      </div>
    </div>
  );
}

function questionsFrom(text: string | null, preview: ImportPreview | null): DisplayQuestion[] {
  if (preview?.quiz) return preview.quiz.questions;
  if (!text) return [];
  try {
    const v = JSON.parse(text) as { questions?: unknown };
    if (!Array.isArray(v.questions)) return [];
    return v.questions.filter(
      (q): q is DisplayQuestion =>
        typeof q === "object" &&
        q !== null &&
        typeof (q as DisplayQuestion).question === "string" &&
        typeof (q as DisplayQuestion).id === "number",
    );
  } catch {
    return [];
  }
}

function parseValue(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    return Array.isArray(v.questions) && v.questions.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** The question id an issue is about. */
function issueQuestion(issue: QuizIssue, questions: DisplayQuestion[]): number | null {
  if (typeof issue.params.id === "number") return issue.params.id;
  const index = issue.path[1];
  return issue.path[0] === "questions" && typeof index === "number" ? (questions[index]?.id ?? null) : null;
}

const NO_CHOICES: FixChoices = { accepted: {}, kept: {} };

function ImportFlow() {
  const { t } = useTranslation();
  const { announce, notify } = useLive();
  const navigate = useNavigate();
  const [pasted, setPasted] = useState("");
  const [original, setOriginal] = useState<{ text: string; filename?: string } | null>(null);
  const [editor, setEditor] = useState("");
  const [preview, setPreview] = useState<{ result: ImportPreview; forText: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [items, setItems] = useState<{ list: VerificationItem[]; done: boolean }>({ list: [], done: false });
  const [choices, setChoices] = useState<FixChoices>(NO_CHOICES);

  const resetVerification = useCallback(() => {
    setJobId(null);
    setItems({ list: [], done: false });
    setChoices(NO_CHOICES);
  }, []);
  const onItems = useCallback((list: VerificationItem[], done: boolean) => setItems({ list, done }), []);
  const onJob = useCallback((id: string) => {
    setJobId(id);
    setItems({ list: [], done: false });
    setChoices(NO_CHOICES);
  }, []);
  const onAccept = useCallback((id: number, fix: string) => {
    setChoices((c) => {
      const { [id]: _kept, ...kept } = c.kept;
      return { accepted: { ...c.accepted, [id]: fix }, kept };
    });
  }, []);
  const onKeep = useCallback((id: number) => {
    setChoices((c) => {
      const { [id]: _fix, ...accepted } = c.accepted;
      return { accepted, kept: { ...c.kept, [id]: true } };
    });
  }, []);

  const previewMutation = useMutation({
    mutationFn: (input: { text: string; filename?: string }) => api.call(importPreview, { body: input }),
    onSuccess: (result, input) => {
      const shown = result.normalizedText ?? input.text;
      setEditor(shown);
      setPreview({ result, forText: shown });
      resetVerification();
      const r = result.report;
      announce(
        r.canSave
          ? t("import:announce.previewOk", {
              questions: r.questionCount,
              fixes: r.fixes.length,
              warnings: r.warnings.length,
            })
          : t("import:announce.previewBlocked", { errors: r.errors.length }),
      );
    },
    onError: (e) => announce(errorText(t, e)),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.call(importCreate, {
        body: {
          originalText: original?.text ?? editor,
          text: editor,
          filename: original?.filename,
          ...(jobId !== null && items.done
            ? {
                verificationJobId: jobId,
                acceptedFixes: Object.entries(choices.accepted).map(([id, correctAnswer]) => ({
                  questionId: Number(id),
                  correctAnswer,
                })),
              }
            : {}),
        },
      }),
    onSuccess: async ({ testId }) => {
      const message = t("import:announce.saved");
      announce(message);
      notify(message);
      await navigate({ to: "/tests/$testId", params: { testId } });
    },
    onError: (e) => announce(errorText(t, e)),
  });

  function start(text: string, filename?: string) {
    setLocalError(null);
    if (new TextEncoder().encode(text).length > IMPORT_MAX_BYTES) {
      const message = t("errors:import_too_large", { maxBytes: IMPORT_MAX_BYTES });
      setLocalError(message);
      announce(message);
      return;
    }
    setOriginal({ text, filename });
    setPreview(null);
    previewMutation.mutate({ text, filename });
  }

  async function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    start(await file.text(), file.name);
  }

  const dirty = preview !== null && preview.forText !== editor;
  const questions = questionsFrom(preview?.forText ?? null, preview?.result ?? null);
  // A confirmed fix clears the error it's for (the server applies it on save); a Wrong answer still open blocks.
  const openErrors = (preview?.result.report.errors ?? []).filter((issue) => {
    const id = issueQuestion(issue, questions);
    return !(issue.code === "answer_not_in_options" && id !== null && choices.accepted[id] !== undefined);
  });
  const openFixes = items.list.filter(
    (i) => i.outcome === "wrong_answer" && choices.accepted[i.questionId] === undefined,
  );
  const verifying = jobId !== null && !items.done;
  const canSave =
    !!preview && openErrors.length === 0 && openFixes.length === 0 && !verifying && !dirty && !saveMutation.isPending;

  return (
    <>
      <Card title={t("import:source.title")}>
        <p>{t("import:source.help")}</p>
        <div className={styles.row}>
          <FileTrigger acceptedFileTypes={[".json", "application/json", "text/plain"]} onSelect={onFiles}>
            <Button variant="secondary">{t("import:source.upload")}</Button>
          </FileTrigger>
        </div>
        <TextField label={t("import:source.paste")} multiline rows={6} value={pasted} onChange={setPasted} />
        <Button onPress={() => start(pasted)} isDisabled={pasted.trim() === "" || previewMutation.isPending}>
          {t("import:source.preview")}
        </Button>
        {localError ? (
          <p className={styles.blocked} role="alert">
            {localError}
          </p>
        ) : null}
        <ErrorMessage error={previewMutation.error} />
      </Card>

      {previewMutation.isPending ? <p>{t("import:previewing")}</p> : null}

      {preview ? (
        <>
          <Report report={preview.result.report} />
          <VerifyPanel
            value={parseValue(preview.forText)}
            jobId={jobId}
            onJob={onJob}
            onItems={onItems}
            choices={choices}
            onAccept={onAccept}
            onKeep={onKeep}
          />
          <Card title={t("import:editor.title")}>
            <JsonEditor value={editor} onChange={setEditor} />
            <div className={styles.row}>
              <Button
                variant="secondary"
                onPress={() => previewMutation.mutate({ text: editor, filename: original?.filename })}
                isDisabled={previewMutation.isPending}
              >
                {t("import:editor.rerun")}
              </Button>
              <Button onPress={() => saveMutation.mutate()} isDisabled={!canSave}>
                {t("import:save")}
              </Button>
            </div>
            {dirty ? <p className={styles.hint}>{t("import:editor.dirty")}</p> : null}
            {!dirty && openErrors.length > 0 ? <p className={styles.hint}>{t("import:editor.fixFirst")}</p> : null}
            {!dirty && openFixes.length > 0 ? (
              <p className={styles.hint}>{t("import:editor.openFixes", { count: openFixes.length })}</p>
            ) : null}
            <ErrorMessage error={saveMutation.error} />
          </Card>
          <Card title={t("import:questions.title", { count: questions.length })}>
            {questions.length > 0 ? <QuestionList questions={questions} /> : <p>{t("import:questions.none")}</p>}
          </Card>
        </>
      ) : null}
    </>
  );
}

export function ImportPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("import:title"));
  return (
    <RequireRole minRole="proctor">
      {() => (
        <>
          <h1>{t("import:title")}</h1>
          <ImportFlow />
        </>
      )}
    </RequireRole>
  );
}
