import { TEST_TYPES, type TestType } from "@gem/shared";
import { authoringSessionsCreate, authoringSessionsList, sourcesList } from "@gem/shared/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";
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
  const create = useMutation({
    mutationFn: () => api.call(authoringSessionsCreate, { body: { title, testType, sources: [{ sourceId: chosen }] } }),
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
          <ErrorMessage error={create.error} />
          <div className={styles.row}>
            <Button type="submit" isDisabled={create.isPending || title.trim() === "" || chosen === ""}>
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
  const query = useQuery({ queryKey: ["authoring", "sessions"], queryFn: () => api.call(authoringSessionsList) });
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
            </tr>
          ))}
        </tbody>
      </table>
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
