import {
  type SourceChunkView,
  type SourceRevisionView,
  type SourceSummary,
  sourcesChunks,
  sourcesDelete,
  sourcesEmbedRetry,
  sourcesEstimate,
  sourcesGet,
  sourcesRevision,
  sourcesSections,
  sourcesUpdate,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiClientError, api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { RequireRole } from "../auth.tsx";
import { formatDateTime, formatNumber } from "../format.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { Disclosure } from "../ui/Disclosure.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Passage } from "../ui/Passage.tsx";
import { ScopeTree } from "../ui/ScopeTree.tsx";
import { Tab, TabList, TabPanel, Tabs } from "../ui/Tabs.tsx";
import styles from "./Sources.module.css";
import { EmbedStatus } from "./Sources.tsx";

export interface SourceSearch {
  revision?: number;
  chunk?: string;
  quote?: string;
}

function Estimate({ sourceId, revision, sectionIds }: { sourceId: string; revision: number; sectionIds: string[] }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["source", sourceId, "estimate", revision, sectionIds],
    queryFn: () => api.call(sourcesEstimate, { params: { id: sourceId }, body: { sectionIds, revision } }),
  });
  if (!query.data) return <ErrorMessage error={query.error} />;
  return (
    <div aria-live="polite">
      <p>
        {t("sources:scope.total", {
          chunks: formatNumber(query.data.chunks),
          tokens: formatNumber(query.data.tokens),
        })}
      </p>
      <ul className={styles.fit}>
        {query.data.fit.map((f) => (
          <li key={f.role}>
            {t(`admin:llm.roleNames.${f.role}`)}
            {": "}
            {f.assigned
              ? f.fits
                ? t("sources:scope.fits")
                : t("sources:scope.tooLarge")
              : t("sources:scope.unassigned")}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChunkItem({
  chunk,
  focused,
  quote,
  label,
}: {
  chunk: SourceChunkView;
  focused: boolean;
  quote?: string | undefined;
  label: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <li ref={ref} className={focused ? styles.cited : styles.chunk}>
      <p className={styles.citation}>
        {focused ? <strong>{t("sources:viewer.cited")} </strong> : null}
        {t("sources:viewer.citation", { label, path: chunk.headingPath.join(" › ") })}
      </p>
      {chunk.flaggedAt ? (
        <p className={styles.bad}>
          <span aria-hidden="true">⚑ </span>
          {t("sources:flagged.chunk", { date: formatDateTime(chunk.flaggedAt) })}
        </p>
      ) : null}
      <Passage text={chunk.text} quote={focused ? quote : undefined} />
    </li>
  );
}

function RevisionList({
  sourceId,
  revisions,
  current,
}: {
  sourceId: string;
  revisions: SourceRevisionView[];
  current: number;
}) {
  const { t } = useTranslation();
  return (
    <ul>
      {revisions.map((r) => (
        <li key={r.id}>
          <Link
            to="/sources/$sourceId"
            params={{ sourceId }}
            search={{ revision: r.number }}
            aria-current={r.number === current}
          >
            {t("sources:revisions.item", { number: formatNumber(r.number), date: formatDateTime(r.createdAt) })}
          </Link>{" "}
          <span className={styles.muted}>{t(`sources:status.${r.embedStatus}`)}</span>
          {r.fileId ? (
            <>
              {" "}
              <a href={`/api/v1/sources/files/${r.fileId}/original`} download>
                {t("sources:revisions.original", { number: formatNumber(r.number) })}
              </a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function EditRevision({ source }: { source: SourceSummary }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const qc = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const load = useMutation({
    mutationFn: () => api.call(sourcesRevision, { params: { id: source.id, n: source.latest.number } }),
    onSuccess: (r) => setText(r.markdown),
  });
  const save = useMutation({
    mutationFn: () => api.call(sourcesUpdate, { params: { id: source.id }, body: { text: text as string } }),
    onSuccess: async ({ source: s }) => {
      setText(null);
      await qc.invalidateQueries({ queryKey: ["source", source.id] });
      announce(t("sources:revisions.saved", { number: s.latest.number }));
    },
    onError: (e) => announce(errorText(t, e)),
  });
  return (
    <div>
      <p className={styles.muted}>{t("sources:revisions.editHelp")}</p>
      {text === null ? (
        <Button variant="secondary" onPress={() => load.mutate()} isDisabled={load.isPending}>
          {t("sources:revisions.start")}
        </Button>
      ) : (
        <>
          <TextField
            label={t("sources:add.text")}
            description={t("sources:revisions.help")}
            value={text}
            onChange={setText}
            multiline
            rows={14}
          />
          <div className={styles.row}>
            <Button onPress={() => save.mutate()} isDisabled={save.isPending}>
              {t("sources:revisions.save")}
            </Button>
            <Button variant="secondary" onPress={() => setText(null)}>
              {t("common:cancel")}
            </Button>
          </div>
        </>
      )}
      <ErrorMessage error={load.error ?? save.error} />
    </div>
  );
}

/**
 * The source's own table of contents: a row per section, opening to its passages. Passages are drawn only for the
 * sections open (a book has hundreds), and a link to a cited passage opens its section and shows it.
 */
function Contents({ source, search, revision }: { source: SourceSummary; search: SourceSearch; revision: number }) {
  const { t } = useTranslation();
  const sourceId = source.id;
  const sections = useQuery({
    queryKey: ["source", sourceId, "sections", revision],
    queryFn: () => api.call(sourcesSections, { params: { id: sourceId }, query: { revision } }),
  });
  const chunks = useQuery({
    queryKey: ["source", sourceId, "chunks", revision],
    queryFn: () => api.call(sourcesChunks, { params: { id: sourceId }, query: { revision } }),
  });
  const list = sections.data?.sections ?? [];
  const bySection = new Map<string, SourceChunkView[]>();
  for (const c of chunks.data?.chunks ?? []) bySection.set(c.sectionId, [...(bySection.get(c.sectionId) ?? []), c]);
  const cited = (chunks.data?.chunks ?? []).find((c) => c.id === search.chunk)?.sectionId;
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (cited) setOpen((o) => new Set(o).add(cited));
  }, [cited]);
  const top = list.length > 0 ? Math.min(...list.map((s) => s.level)) : 1;
  return (
    <>
      <ErrorMessage error={sections.error ?? chunks.error} />
      {list.length === 0 && !sections.isPending ? <p>{t("sources:viewer.empty")}</p> : null}
      <div className={styles.contents}>
        {list.map((s) => {
          const own = bySection.get(s.id) ?? [];
          return (
            <div key={s.id} style={{ paddingInlineStart: `${(s.level - top) * 1.25}rem` }}>
              <Disclosure
                variant="row"
                level={2}
                title={s.title}
                summary={
                  own.length > 0
                    ? t("sources:contents.passages", { count: own.length })
                    : t("sources:contents.noPassages")
                }
                isExpanded={open.has(s.id)}
                onExpandedChange={(isOpen) =>
                  setOpen((o) => {
                    const next = new Set(o);
                    if (isOpen) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  })
                }
              >
                {open.has(s.id) ? (
                  <ul className={styles.chunks}>
                    {own.map((c) => (
                      <ChunkItem
                        key={c.id}
                        chunk={c}
                        focused={c.id === search.chunk}
                        quote={search.quote}
                        label={source.citationLabel}
                      />
                    ))}
                  </ul>
                ) : null}
              </Disclosure>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** Which sections fit each model role: the size of a choice of sections, before a session is made from them. */
function SizeCheck({ source, revision }: { source: SourceSummary; revision: number }) {
  const { t } = useTranslation();
  const sections = useQuery({
    queryKey: ["source", source.id, "sections", revision],
    queryFn: () => api.call(sourcesSections, { params: { id: source.id }, query: { revision } }),
  });
  const list = sections.data?.sections ?? [];
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const chosen = selected ?? new Set(list.map((s) => s.id));
  return (
    <>
      <p className={styles.muted}>{t("sources:scope.help")}</p>
      <ErrorMessage error={sections.error} />
      <ScopeTree sections={list} selected={chosen} onChange={setSelected} label={t("sources:scope.label")} />
      <Estimate sourceId={source.id} revision={revision} sectionIds={[...chosen]} />
    </>
  );
}

function Flagged({ source, revision }: { source: SourceSummary; revision: number }) {
  const { t } = useTranslation();
  const chunks = useQuery({
    queryKey: ["source", source.id, "chunks", revision],
    queryFn: () => api.call(sourcesChunks, { params: { id: source.id }, query: { revision } }),
  });
  const flagged = (chunks.data?.chunks ?? []).filter((c) => c.flaggedAt !== null);
  return (
    <>
      <p className={styles.muted}>{t("sources:flagged.help")}</p>
      <ul className={styles.chunks}>
        {flagged.map((c) => (
          <ChunkItem key={c.id} chunk={c} focused={false} label={source.citationLabel} />
        ))}
      </ul>
    </>
  );
}

function Detail({ sourceId, search }: { sourceId: string; search: SourceSearch }) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ["source", sourceId],
    queryFn: () => api.call(sourcesGet, { params: { id: sourceId } }),
  });
  useDocumentTitle(query.data?.source.title ?? t("sources:list.title"));
  const [deleting, setDeleting] = useState(false);

  const said = useRef("");
  useServerState<SourceSummary>(`/sources/${sourceId}/events`, (state) => {
    const before = qc.getQueryData<typeof query.data>(["source", sourceId])?.source.latest;
    qc.setQueryData(["source", sourceId], (old: typeof query.data) => (old ? { ...old, source: state } : old));
    const { embedStatus, embedded, chunks, number } = state.latest;
    const key = `${number}:${embedStatus}:${embedded}`;
    if (key === said.current) return;
    said.current = key;
    // A page opened on a finished source says nothing; one that saw it unfinished says how it ended.
    const changed = before !== undefined && before.embedStatus !== embedStatus;
    if (embedStatus === "embedding") {
      announce(t("sources:announce.progress", { done: embedded, total: chunks }));
    } else if (embedStatus === "ready" && changed) {
      announce(t("sources:announce.ready", { title: state.title }));
      void qc.invalidateQueries({ queryKey: ["source", sourceId] });
    } else if (embedStatus === "failed" && changed) {
      announce(t("sources:announce.failed", { title: state.title }));
    }
  });
  const flaggedCount = useQuery({
    queryKey: ["source", sourceId, "chunks", search.revision ?? query.data?.source.latest.number],
    queryFn: () =>
      api.call(sourcesChunks, {
        params: { id: sourceId },
        query: { revision: search.revision ?? (query.data?.source.latest.number as number) },
      }),
    enabled: query.data !== undefined,
    select: (d) => d.chunks.filter((c) => c.flaggedAt !== null).length,
  });

  const retry = useMutation({
    mutationFn: () => api.call(sourcesEmbedRetry, { params: { id: sourceId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source", sourceId] }),
    onError: (e) => announce(errorText(t, e)),
  });
  const remove = useMutation({
    mutationFn: () => api.call(sourcesDelete, { params: { id: sourceId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["sources"] });
      announce(t("sources:deleted"));
      await navigate({ to: "/sources" });
    },
  });

  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (!query.data) {
    const gone = query.error instanceof ApiClientError && query.error.status === 404;
    return gone ? <p>{t("errors:source_not_found")}</p> : <ErrorMessage error={query.error} />;
  }
  const { source, revisions } = query.data;
  const error = source.latest.embedError;
  const revision = search.revision ?? source.latest.number;
  const flagged = flaggedCount.data ?? 0;
  return (
    <>
      <PageHeader
        title={source.title}
        description={
          <span className={styles.headerMeta}>
            <span>{t("sources:detail.citation", { label: source.citationLabel })}</span>
            <EmbedStatus source={source} />
          </span>
        }
        actions={
          <Menu
            label={t("sources:detail.actions")}
            variant="secondary"
            items={
              <MenuItem danger onAction={() => setDeleting(true)}>
                {t("sources:delete.action")}
              </MenuItem>
            }
          />
        }
      />
      {error ? (
        <div className={styles.row}>
          <p className={styles.bad}>{errorText(t, new ApiClientError(error.code, error.params, 0))}</p>
          <Button variant="secondary" onPress={() => retry.mutate()} isDisabled={retry.isPending}>
            {t("sources:retry")}
          </Button>
        </div>
      ) : null}
      <ErrorMessage error={retry.error} />
      <Tabs label={t("sources:tabs.label")} defaultSelectedKey="contents">
        <TabList label={t("sources:tabs.label")}>
          <Tab id="contents">{t("sources:tabs.contents")}</Tab>
          <Tab id="revisions" count={revisions.length}>
            {t("sources:tabs.revisions")}
          </Tab>
          <Tab id="edit">{t("sources:tabs.edit")}</Tab>
          <Tab id="size">{t("sources:tabs.size")}</Tab>
          {flagged > 0 ? (
            <Tab id="flagged" count={flagged}>
              {t("sources:tabs.flagged")}
            </Tab>
          ) : null}
        </TabList>
        <TabPanel id="contents">
          <Contents key={revision} source={source} search={search} revision={revision} />
        </TabPanel>
        <TabPanel id="revisions">
          <RevisionList sourceId={sourceId} revisions={revisions} current={revision} />
        </TabPanel>
        <TabPanel id="edit">
          <EditRevision source={source} />
        </TabPanel>
        <TabPanel id="size">
          <SizeCheck key={revision} source={source} revision={revision} />
        </TabPanel>
        {flagged > 0 ? (
          <TabPanel id="flagged">
            <Flagged source={source} revision={revision} />
          </TabPanel>
        ) : null}
      </Tabs>
      <ConfirmDialog
        isOpen={deleting}
        onOpenChange={setDeleting}
        title={t("sources:delete.title")}
        confirmLabel={t("sources:delete.confirm")}
        cancelLabel={t("common:cancel")}
        onConfirm={() => remove.mutate()}
        isPending={remove.isPending}
        variant="danger"
      >
        <p>{t("sources:delete.body")}</p>
      </ConfirmDialog>
    </>
  );
}

export function SourceDetailPage({ sourceId, search }: { sourceId: string; search: SourceSearch }) {
  return <RequireRole minRole="proctor">{() => <Detail sourceId={sourceId} search={search} />}</RequireRole>;
}
