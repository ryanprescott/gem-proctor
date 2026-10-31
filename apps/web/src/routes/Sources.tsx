import type { SourcePreview, SourceWarning } from "@gem/shared";
import { type SourceSummary, sourcesCreate, sourcesList, sourcesPreview } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import styles from "./Sources.module.css";

export function EmbedStatus({ source }: { source: Pick<SourceSummary, "latest"> }) {
  const { t } = useTranslation();
  const { embedStatus, embedded, chunks } = source.latest;
  return (
    <span className={embedStatus === "failed" ? styles.bad : embedStatus === "ready" ? styles.good : undefined}>
      <span aria-hidden="true">{embedStatus === "ready" ? "✓ " : embedStatus === "failed" ? "✕ " : "… "}</span>
      {t(`sources:status.${embedStatus}`)}
      {embedStatus === "embedding"
        ? ` ${t("sources:progress", { done: formatNumber(embedded), total: formatNumber(chunks) })}`
        : null}
    </span>
  );
}

function Warnings({ warnings }: { warnings: SourceWarning[] }) {
  const { t } = useTranslation();
  if (warnings.length === 0) return <p>{t("sources:preview.noWarnings")}</p>;
  return (
    <ul className={styles.warnings}>
      {warnings.map((w) => (
        <li key={`${w.code}:${w.heading ?? ""}`}>
          {t(`sources:warnings.${w.code}`, { heading: w.heading ?? "", tokens: formatNumber(w.tokens ?? 0) })}
        </li>
      ))}
    </ul>
  );
}

function PreviewPanel({ preview }: { preview: SourcePreview }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="source-preview">
      <h3 id="source-preview">{t("sources:preview.title")}</h3>
      <p>
        {t("sources:preview.summary", {
          sections: formatNumber(preview.sections.length),
          chunks: formatNumber(preview.chunks),
          tokens: formatNumber(preview.tokens),
        })}
      </p>
      <Warnings warnings={preview.warnings} />
      <ul className={styles.outline}>
        {preview.sections.map((s) => (
          <li key={s.order} style={{ marginInlineStart: `${(s.level - 1) * 1}rem` }}>
            <Markdown inline>{s.title}</Markdown>{" "}
            <span className={styles.muted}>{t("sources:preview.sectionChunks", { count: s.chunks })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AddSource() {
  const { t } = useTranslation();
  const { announce } = useLive();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [label, setLabel] = useState("");
  const [author, setAuthor] = useState("");
  const [edition, setEdition] = useState("");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [preview, setPreview] = useState<SourcePreview | null>(null);

  const body = () => ({
    text,
    ...(filename ? { filename } : {}),
  });
  const look = useMutation({
    mutationFn: () => api.call(sourcesPreview, { body: { ...body(), ...(title ? { title } : {}) } }),
    onSuccess: (p) => {
      setPreview(p);
      announce(t("sources:preview.ready", { count: p.sections.length }));
    },
    onError: (e) => announce(errorText(t, e)),
  });
  const save = useMutation({
    mutationFn: () =>
      api.call(sourcesCreate, {
        body: {
          ...body(),
          title,
          citationLabel: label,
          ...(author ? { author } : {}),
          ...(edition ? { edition } : {}),
          ...(url ? { url } : {}),
        },
      }),
    onSuccess: async ({ source }) => {
      await qc.invalidateQueries({ queryKey: ["sources"] });
      announce(t("sources:saved", { title: source.title }));
      await navigate({ to: "/sources/$sourceId", params: { sourceId: source.id }, search: {} });
    },
    onError: (e) => announce(errorText(t, e)),
  });

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setText(await file.text());
    setFilename(file.name);
    setPreview(null);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <Card title={t("sources:add.title")}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField label={t("sources:add.titleLabel")} value={title} onChange={setTitle} isRequired />
        <TextField
          label={t("sources:add.citationLabel")}
          description={t("sources:add.citationHelp")}
          value={label}
          onChange={setLabel}
          isRequired
        />
        <TextField label={t("sources:add.author")} value={author} onChange={setAuthor} />
        <TextField label={t("sources:add.edition")} value={edition} onChange={setEdition} />
        <TextField label={t("sources:add.url")} value={url} onChange={setUrl} inputType="url" />
        <div className={styles.row}>
          <FileTrigger acceptedFileTypes={[".md", ".markdown", ".txt"]} onSelect={(f) => void pick(f)}>
            <Button variant="secondary">{t("sources:add.upload")}</Button>
          </FileTrigger>
          {filename ? <span>{t("sources:add.chosen", { name: filename })}</span> : null}
        </div>
        <TextField
          label={t("sources:add.text")}
          description={t("sources:add.textHelp")}
          value={text}
          onChange={(v) => {
            setText(v);
            setFilename(undefined);
            setPreview(null);
          }}
          multiline
          rows={12}
        />
        <div className={styles.row}>
          <Button variant="secondary" onPress={() => look.mutate()} isDisabled={text.trim() === "" || look.isPending}>
            {t("sources:add.preview")}
          </Button>
          <Button type="submit" isDisabled={!title.trim() || !label.trim() || !text.trim() || save.isPending}>
            {t("sources:add.save")}
          </Button>
        </div>
        <ErrorMessage error={look.error ?? save.error} />
      </Form>
      {preview ? <PreviewPanel preview={preview} /> : null}
    </Card>
  );
}

function SourcesTable() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["sources"], queryFn: () => api.call(sourcesList) });
  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (!query.data) return <ErrorMessage error={query.error} />;
  if (query.data.sources.length === 0) return <p>{t("sources:list.empty")}</p>;
  return (
    <div className={styles.tableWrap}>
      <table>
        <caption className={styles.caption}>{t("sources:list.caption", { count: query.data.sources.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("sources:list.colTitle")}</th>
            <th scope="col">{t("sources:list.colLabel")}</th>
            <th scope="col">{t("sources:list.colRevision")}</th>
            <th scope="col">{t("sources:list.colChunks")}</th>
            <th scope="col">{t("sources:list.colStatus")}</th>
            <th scope="col">{t("sources:list.colAdded")}</th>
          </tr>
        </thead>
        <tbody>
          {query.data.sources.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to="/sources/$sourceId" params={{ sourceId: s.id }} search={{}}>
                  {s.title}
                </Link>
              </td>
              <td>{s.citationLabel}</td>
              <td>{formatNumber(s.latest.number)}</td>
              <td>{formatNumber(s.latest.chunks)}</td>
              <td>
                <EmbedStatus source={s} />
              </td>
              <td>{formatDate(s.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SourcesPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("sources:list.title"));
  return (
    <RequireRole minRole="proctor">
      {() => (
        <>
          <h1>{t("sources:list.title")}</h1>
          <SourcesTable />
          <AddSource />
        </>
      )}
    </RequireRole>
  );
}
