import type { SourcePreview } from "@gem/shared";
import {
  type SourceFileView,
  type SourceSummary,
  sourcesCreate,
  sourcesList,
  sourcesPreview,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { PdfChoice, type PdfPlan } from "./SourcePdfChoice.tsx";
import styles from "./Sources.module.css";
import { SourceUploads } from "./SourceUploads.tsx";
import { Warnings } from "./SourceWarnings.tsx";

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

/** The form's text: typed or pasted (or a `.md`/`.txt` file), or one of the creator's read PDFs. */
const TYPED = "typed";

function AddSource({
  pdfs,
  chosen,
  onChoose,
  focusRequest,
}: {
  /** The creator's PDFs that have been read and aren't sources yet. */
  pdfs: SourceFileView[];
  /** `TYPED`, or the id of the PDF to make the source from. */
  chosen: string;
  onChoose: (id: string) => void;
  /** Bumped to move focus to the form, as "Make a source" in the PDFs list does. */
  focusRequest: number;
}) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [label, setLabel] = useState("");
  const [author, setAuthor] = useState("");
  const [edition, setEdition] = useState("");
  const [url, setUrl] = useState("");
  // The typed text is kept while a PDF is chosen: choosing one never loses it.
  const [typed, setTyped] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [plan, setPlan] = useState<PdfPlan>({ perChapter: false, chapters: [] });
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const fileId = chosen === TYPED ? undefined : chosen;
  const pdf = pdfs.find((f) => f.id === fileId);
  const perChapter = fileId !== undefined && plan.perChapter;

  const titleField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest === 0) return;
    titleField.current?.focus();
  }, [focusRequest]);
  // A PDF newly chosen: its name for the title if there's none yet, and a fresh plan. Keyed on the choice, not on
  // the list's entry, which the stream replaces on every change to any file.
  const pdfName = pdf?.filename;
  useEffect(() => {
    if (fileId === undefined) return;
    setPlan({ perChapter: false, chapters: [] });
    if (pdfName) setTitle((current) => current || pdfName.replace(/\.[^.]+$/, ""));
  }, [fileId, pdfName]);
  // A PDF that's gone from the list (removed, or made into a source elsewhere) can't be chosen any more.
  useEffect(() => {
    if (fileId && !pdf) onChoose(TYPED);
  }, [fileId, pdf, onChoose]);

  const meta = () => ({
    citationLabel: label,
    ...(author ? { author } : {}),
    ...(edition ? { edition } : {}),
    ...(url ? { url } : {}),
  });
  const look = useMutation({
    mutationFn: () => api.call(sourcesPreview, { body: { text: typed, ...(title ? { title } : {}) } }),
    onSuccess: (p) => {
      setPreview(p);
      announce(t("sources:preview.ready", { count: p.sections.length }));
    },
    onError: (e) => announce(errorText(t, e)),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (!fileId) {
        return [
          await api.call(sourcesCreate, { body: { ...meta(), title, text: typed, ...(filename ? { filename } : {}) } }),
        ];
      }
      if (!perChapter) return [await api.call(sourcesCreate, { body: { ...meta(), title, fileId } })];
      // One source per chapter, each made on the server from its pages.
      const made = [];
      for (const c of plan.chapters) {
        made.push(
          await api.call(sourcesCreate, {
            body: { ...meta(), title: c.title, fileId, pageRange: `${c.page}-${c.lastPage}` },
          }),
        );
      }
      return made;
    },
    onSuccess: async (made) => {
      await qc.invalidateQueries({ queryKey: ["sources"] });
      if (made.length === 1 && made[0]) {
        announce(t("sources:saved", { title: made[0].source.title }));
        await navigate({ to: "/sources/$sourceId", params: { sourceId: made[0].source.id }, search: {} });
        return;
      }
      announce(t("sources:savedMany", { count: made.length }));
      onChoose(TYPED);
    },
    onError: (e) => announce(errorText(t, e)),
  });

  const pick = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setTyped(await file.text());
    setFilename(file.name);
    setPreview(null);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
  };
  const ready = fileId
    ? perChapter
      ? plan.chapters.length > 0
      : title.trim() !== ""
    : typed.trim() !== "" && title.trim() !== "";

  return (
    <Card title={t("sources:add.title")}>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && label.trim()) save.mutate();
        }}
      >
        {perChapter ? (
          <p>{t("sources:add.chapterTitles")}</p>
        ) : (
          <TextField
            label={t("sources:add.titleLabel")}
            value={title}
            onChange={setTitle}
            isRequired
            inputRef={titleField}
          />
        )}
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
        <Select
          label={t("sources:add.sourceText")}
          selectedKey={chosen}
          onSelectionChange={(id) => {
            setPreview(null);
            onChoose(id);
          }}
          options={[
            { id: TYPED, label: t("sources:add.typed") },
            ...pdfs.map((f) => ({ id: f.id, label: t("sources:add.fromPdf", { name: f.filename }) })),
          ]}
        />
        {fileId ? (
          <PdfChoice fileId={fileId} plan={plan} onPlan={setPlan} />
        ) : (
          <>
            <div className={styles.row}>
              <FileTrigger acceptedFileTypes={[".md", ".markdown", ".txt"]} onSelect={(f) => void pick(f)}>
                <Button variant="secondary">{t("sources:add.upload")}</Button>
              </FileTrigger>
              {filename ? <span>{t("sources:add.chosen", { name: filename })}</span> : null}
            </div>
            <TextField
              label={t("sources:add.text")}
              description={t("sources:add.textHelp")}
              value={typed}
              onChange={(v) => {
                setTyped(v);
                setFilename(undefined);
                setPreview(null);
              }}
              multiline
              rows={12}
            />
          </>
        )}
        <div className={styles.row}>
          {fileId ? null : (
            <Button
              variant="secondary"
              onPress={() => look.mutate()}
              isDisabled={typed.trim() === "" || look.isPending}
            >
              {t("sources:add.preview")}
            </Button>
          )}
          <Button type="submit" isDisabled={!ready || !label.trim() || save.isPending}>
            {perChapter ? t("sources:add.saveChapters", { count: plan.chapters.length }) : t("sources:add.save")}
          </Button>
        </div>
        <ErrorMessage error={look.error ?? save.error} />
      </Form>
      {preview && !fileId ? <PreviewPanel preview={preview} /> : null}
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
  const { announce } = useLive();
  useDocumentTitle(t("sources:list.title"));
  // One stream for the page: the PDFs section shows it, and the form offers the read ones.
  const [files, setFiles] = useState<SourceFileView[] | null>(null);
  useServerState<{ files: SourceFileView[] }>("/sources/files/events", ({ files }) => setFiles(files));
  const [chosen, setChosen] = useState(TYPED);
  const [focusRequest, setFocusRequest] = useState(0);
  const ready = (files ?? []).filter((f) => f.status === "ready");
  return (
    <RequireRole minRole="proctor">
      {() => (
        <>
          <h1>{t("sources:list.title")}</h1>
          <SourcesTable />
          <SourceUploads
            files={files}
            onMakeSource={(id) => {
              setChosen(id);
              setFocusRequest((n) => n + 1);
              const name = ready.find((f) => f.id === id)?.filename ?? "";
              announce(t("sources:uploads.madeSource", { name }));
            }}
          />
          <AddSource pdfs={ready} chosen={chosen} onChoose={setChosen} focusRequest={focusRequest} />
        </>
      )}
    </RequireRole>
  );
}
