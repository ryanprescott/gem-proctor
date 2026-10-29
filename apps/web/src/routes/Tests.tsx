import { testsExport, testsGet, testsList, testsUpdate } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api, contractUrl } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { QuestionList } from "../ui/QuestionList.tsx";
import styles from "./Tests.module.css";

type Archived = "exclude" | "include" | "only";

function TestsTable() {
  const { t } = useTranslation();
  const [archived, setArchived] = useState<Archived>("exclude");
  const query = useQuery({
    queryKey: ["tests", archived],
    queryFn: () => api.call(testsList, { query: { archived } }),
  });
  return (
    <>
      <div className={styles.toolbar}>
        <Select
          label={t("tests:list.show")}
          selectedKey={archived}
          onSelectionChange={(k) => setArchived(k as Archived)}
          options={[
            { id: "exclude", label: t("tests:list.active") },
            { id: "include", label: t("tests:list.all") },
            { id: "only", label: t("tests:list.archived") },
          ]}
        />
        <Link to="/import" className={styles.importLink}>
          {t("tests:list.import")}
        </Link>
      </div>
      <ErrorMessage error={query.error} />
      {query.isPending ? <p>{t("common:loading")}</p> : null}
      {query.data && query.data.tests.length === 0 ? <p>{t("tests:list.empty")}</p> : null}
      {query.data && query.data.tests.length > 0 ? (
        <div className={styles.tableWrap}>
          <table>
            <caption className={styles.caption}>{t("tests:list.caption", { count: query.data.tests.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t("tests:list.colTitle")}</th>
                <th scope="col">{t("tests:list.colQuestions")}</th>
                <th scope="col">{t("tests:list.colOwner")}</th>
                <th scope="col">{t("tests:list.colCreated")}</th>
                <th scope="col">{t("tests:list.colStatus")}</th>
              </tr>
            </thead>
            <tbody>
              {query.data.tests.map((test) => (
                <tr key={test.id}>
                  <td>
                    <Link to="/tests/$testId" params={{ testId: test.id }}>
                      {test.title}
                    </Link>
                  </td>
                  <td>{formatNumber(test.questionCount)}</td>
                  <td>{test.ownerName}</td>
                  <td>{formatDate(test.createdAt)}</td>
                  <td>{test.archivedAt ? t("tests:status.archived") : t("tests:status.active")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

export function TestsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("tests:list.title"));
  return (
    <RequireRole minRole="proctor">
      {() => (
        <>
          <h1>{t("tests:list.title")}</h1>
          <TestsTable />
        </>
      )}
    </RequireRole>
  );
}

function TestDetail({ testId }: { testId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { announce, notify } = useLive();
  const query = useQuery({ queryKey: ["test", testId], queryFn: () => api.call(testsGet, { params: { id: testId } }) });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  useDocumentTitle(query.data?.test.title ?? t("tests:detail.title"));

  useEffect(() => {
    if (!query.data) return;
    setTitle(query.data.test.title);
    setDescription(query.data.test.description ?? "");
    setTags(query.data.test.tags.join(", "));
  }, [query.data]);

  const update = useMutation({
    mutationFn: (body: { title?: string; description?: string | null; tags?: string[]; archived?: boolean }) =>
      api.call(testsUpdate, { params: { id: testId }, body }),
    onSuccess: async (_r, body) => {
      await qc.invalidateQueries({ queryKey: ["test", testId] });
      await qc.invalidateQueries({ queryKey: ["tests"] });
      const message =
        body.archived === undefined
          ? t("tests:announce.saved")
          : body.archived
            ? t("tests:announce.archived")
            : t("tests:announce.restored");
      announce(message);
      notify(message);
    },
    onError: (e) => announce(errorText(t, e)),
  });

  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (query.error || !query.data) return <ErrorMessage error={query.error} />;
  const { test, version, content } = query.data;

  return (
    <>
      <h1>{test.title}</h1>
      <dl className={styles.meta}>
        <dt>{t("tests:detail.status")}</dt>
        <dd>
          {test.archivedAt
            ? t("tests:status.archivedOn", { date: formatDate(test.archivedAt) })
            : t("tests:status.active")}
        </dd>
        <dt>{t("tests:detail.version")}</dt>
        <dd>{t("tests:detail.versionValue", { n: version.versionNumber, date: formatDate(version.createdAt) })}</dd>
        <dt>{t("tests:detail.questions")}</dt>
        <dd>{formatNumber(content.questions.length)}</dd>
        {content.course ? (
          <>
            <dt>{t("tests:detail.course")}</dt>
            <dd>{content.course}</dd>
          </>
        ) : null}
        {content.chapter !== undefined ? (
          <>
            <dt>{t("tests:detail.chapter")}</dt>
            <dd>{formatNumber(content.chapter)}</dd>
          </>
        ) : null}
        <dt>{t("tests:detail.owner")}</dt>
        <dd>{test.ownerName}</dd>
        <dt>{t("tests:detail.created")}</dt>
        <dd>{formatDate(test.createdAt)}</dd>
      </dl>

      <div className={styles.actions}>
        <a className={styles.exportLink} href={contractUrl(testsExport, { params: { id: testId } })} download>
          {t("tests:detail.export")}
        </a>
        <Button
          variant={test.archivedAt ? "secondary" : "danger"}
          onPress={() => update.mutate({ archived: !test.archivedAt })}
          isDisabled={update.isPending}
        >
          {test.archivedAt ? t("tests:detail.restore") : t("tests:detail.archive")}
        </Button>
      </div>

      <Card title={t("tests:detail.editTitle")}>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({
              title,
              description: description.trim() === "" ? null : description,
              tags: tags
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            });
          }}
        >
          <TextField label={t("tests:detail.fieldTitle")} value={title} onChange={setTitle} isRequired />
          <TextField
            label={t("tests:detail.fieldDescription")}
            value={description}
            onChange={setDescription}
            multiline
            rows={3}
          />
          <TextField
            label={t("tests:detail.fieldTags")}
            description={t("tests:detail.tagsHelp")}
            value={tags}
            onChange={setTags}
          />
          <ErrorMessage error={update.error} />
          <Button type="submit" isDisabled={update.isPending}>
            {t("tests:detail.save")}
          </Button>
        </Form>
      </Card>

      {content.topics_covered && content.topics_covered.length > 0 ? (
        <Card title={t("tests:detail.topics")}>
          <ul>
            {content.topics_covered.map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <h2>{t("tests:detail.questionsTitle")}</h2>
      <QuestionList questions={content.questions} />
    </>
  );
}

export function TestDetailPage({ testId }: { testId: string }) {
  return <RequireRole minRole="proctor">{() => <TestDetail testId={testId} />}</RequireRole>;
}
