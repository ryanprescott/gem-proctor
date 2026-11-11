import { TEST_TYPES, type TestType } from "@gem/shared";
import {
  authoringSessionsCreate,
  authoringSessionsDelete,
  authoringSessionsList,
  type SessionSummary,
  sourcesList,
  sourcesSections,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatNumber } from "../format.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, errorText, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { LONG_SOURCE_SECTIONS, partsOf, ScopeTree, scopeOf } from "../ui/ScopeTree.tsx";
import styles from "./Authoring.module.css";

function NewSession() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => api.call(sourcesList) });
  const usable = (sources.data?.sources ?? []).filter((s) => s.usable);
  const [title, setTitle] = useState("");
  const [testType, setTestType] = useState<TestType>("chapter_quiz");
  const [sourceId, setSourceId] = useState("");
  const chosen = sourceId || usable[0]?.id || "";
  const sections = useQuery({
    queryKey: ["source", chosen, "sections", "latest"],
    queryFn: () => api.call(sourcesSections, { params: { id: chosen }, query: {} }),
    enabled: chosen !== "",
  });
  const { content } = partsOf(sections.data?.sections ?? []);
  // A book is too big to be what a test covers: it has to say which chapters, so a "Chapter 1 quiz" is one.
  const isBook = content.length > LONG_SOURCE_SECTIONS;
  const [picks, setPicks] = useState<Record<string, Set<string>>>({});
  const picked = picks[chosen] ?? (isBook ? new Set<string>() : new Set(content.map((x) => x.id)));
  const create = useMutation({
    mutationFn: () =>
      api.call(authoringSessionsCreate, {
        body: { title, testType, sources: [{ sourceId: chosen, ...scopeOf(picked, content), exerciseSectionIds: [] }] },
      }),
    onSuccess: (detail) => navigate({ to: "/authoring/$sessionId", params: { sessionId: detail.session.id } }),
  });
  return (
    <Card title={t("authoring:new.title")}>
      {sources.data && usable.length === 0 ? (
        <p>
          {t("authoring:new.noSources")} <Link to="/sources">{t("authoring:new.toSources")}</Link>
        </p>
      ) : (
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <TextField label={t("authoring:new.name")} value={title} onChange={setTitle} isRequired />
          <Select
            label={t("authoring:new.testType")}
            selectedKey={testType}
            onSelectionChange={(k) => setTestType(k as TestType)}
            options={TEST_TYPES.map((id) => ({ id, label: t(`authoring:testTypes.${id}`) }))}
          />
          <Select
            label={t("authoring:new.source")}
            selectedKey={chosen}
            onSelectionChange={setSourceId}
            options={usable.map((s) => ({ id: s.id, label: s.title }))}
          />
          {content.length > 0 ? (
            <>
              {isBook ? (
                <p className={styles.muted} role="note">
                  {t("authoring:new.pickChapters")}
                </p>
              ) : null}
              <ScopeTree
                sections={content}
                selected={picked}
                label={t("authoring:new.scope")}
                onChange={(next) => setPicks((p) => ({ ...p, [chosen]: next }))}
              />
            </>
          ) : null}
          <ErrorMessage error={create.error ?? sections.error} />
          <div className={styles.row}>
            <Button
              type="submit"
              isDisabled={create.isPending || title.trim() === "" || chosen === "" || picked.size === 0}
            >
              {t("authoring:new.create")}
            </Button>
          </div>
        </Form>
      )}
    </Card>
  );
}

function SessionsTable() {
  const { t } = useTranslation();
  const { announce } = useLive();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["authoring", "sessions"], queryFn: () => api.call(authoringSessionsList) });
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const remove = useMutation({
    mutationFn: (s: SessionSummary) => api.call(authoringSessionsDelete, { params: { id: s.id } }),
    onSuccess: async (_r, s) => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ["authoring", "sessions"] });
      announce(t("authoring:list.deleted", { title: s.title }));
    },
    onError: (e) => announce(errorText(t, e)),
  });
  if (!query.data) return <ErrorMessage error={query.error} />;
  if (query.data.sessions.length === 0) return <p>{t("authoring:list.empty")}</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.stack}>
        <caption className={styles.muted}>{t("authoring:list.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("authoring:list.colTitle")}</th>
            <th scope="col">{t("authoring:list.colType")}</th>
            <th scope="col">{t("authoring:list.colStatus")}</th>
            <th scope="col">{t("authoring:list.colQuestions")}</th>
            <th scope="col">{t("authoring:list.colCreated")}</th>
            <th scope="col">{t("authoring:list.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {query.data.sessions.map((s) => (
            <tr key={s.id}>
              <td data-label={t("authoring:list.colTitle")}>
                <Link to="/authoring/$sessionId" params={{ sessionId: s.id }}>
                  {s.title}
                </Link>
              </td>
              <td data-label={t("authoring:list.colType")}>{t(`authoring:testTypes.${s.testType}`)}</td>
              <td data-label={t("authoring:list.colStatus")}>{t(`authoring:session.status.${s.status}`)}</td>
              <td data-label={t("authoring:list.colQuestions")}>{formatNumber(s.questionCount)}</td>
              <td data-label={t("authoring:list.colCreated")}>{formatDate(s.createdAt)}</td>
              <td data-label={t("authoring:list.colActions")}>
                <Button
                  variant="secondary"
                  onPress={() => setDeleting(s)}
                  aria-label={t("authoring:list.deleteFor", { title: s.title })}
                >
                  {t("authoring:list.delete")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorMessage error={remove.error} />
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("authoring:list.deleteTitle", { title: deleting?.title ?? "" })}
        confirmLabel={t("authoring:list.delete")}
        cancelLabel={t("common:cancel")}
        onConfirm={() => deleting && remove.mutate(deleting)}
        isPending={remove.isPending}
        variant="danger"
      >
        <p>{t("authoring:list.deleteHelp")}</p>
      </ConfirmDialog>
    </div>
  );
}

export function AuthoringPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("authoring:list.title"));
  return (
    <RequireRole minRole="proctor">
      {() => (
        <>
          <h1>{t("authoring:list.title")}</h1>
          <SessionsTable />
          <NewSession />
        </>
      )}
    </RequireRole>
  );
}
