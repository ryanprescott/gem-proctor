import { PAGE_RANGE_PATTERN } from "@gem/shared";
import { type SourceFileDetail, sourcesFilesCreate, sourcesFilesRetry } from "@gem/shared/contracts";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { formatNumber } from "../format.ts";
import { Button, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import styles from "./Sources.module.css";

const progressText = (t: TFunction, s: SourceFileDetail) => {
  if (s.status === "pending") return t("sources:pdf.pending", { name: s.filename });
  // A long PDF is read in batches, and how far it has got is saved after each.
  if (s.pagesConverted && s.pageCount) {
    return s.pageRange
      ? t("sources:pdf.convertingSome", { name: s.filename, done: formatNumber(s.pagesConverted) })
      : t("sources:pdf.convertingOf", {
          name: s.filename,
          done: formatNumber(s.pagesConverted),
          total: formatNumber(s.pageCount),
        });
  }
  return t("sources:pdf.converting", { name: s.filename });
};

const PAGES = new RegExp(PAGE_RANGE_PATTERN);

/**
 * Choosing a PDF (docs/P2.2.md §6): the upload, the reader's progress said aloud as it changes, a failure in words with
 * a retry, and the finished Markdown handed up for the creator to look at and edit before anything is saved.
 */
export function PdfReader({
  onReady,
  onFollow,
}: {
  onReady: (file: SourceFileDetail) => void;
  /** The file this reader follows, so the list of uploads doesn't say the same thing again. */
  onFollow?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const [pages, setPages] = useState("");
  const [fileId, setFileId] = useState<string | null>(null);
  const [state, setState] = useState<SourceFileDetail | null>(null);
  const last = useRef<string>("");
  const pagesError = pages.trim() !== "" && !PAGES.test(pages.trim()) ? t("sources:pdf.pagesInvalid") : undefined;

  const send = useMutation({
    mutationFn: (file: File) =>
      api.upload(sourcesFilesCreate, {
        query: { filename: file.name, ...(pages.trim() ? { pageRange: pages.trim() } : {}) },
        file: new File([file], file.name, { type: "application/pdf" }),
      }),
    onSuccess: ({ file }) => {
      setFileId(file.id);
      onFollow?.(file.id);
      setState({ ...file, markdown: null });
    },
    onError: (e) => announce(errorText(t, e)),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.call(sourcesFilesRetry, { params: { id } }),
    onSuccess: ({ file }) => setState({ ...file, markdown: null }),
    onError: (e) => announce(errorText(t, e)),
  });

  useServerState<{ file: SourceFileDetail }>(fileId ? `/sources/files/${fileId}/events` : null, ({ file }) =>
    setState(file),
  );

  // Said once per change of state, not once per message.
  useEffect(() => {
    if (!state) return;
    const key = `${state.id}:${state.status}`;
    if (key === last.current) return;
    last.current = key;
    if (state.status === "ready") {
      announce(t("sources:pdf.ready", { name: state.filename, pages: formatNumber(state.pagesConverted ?? 0) }));
      onReady(state);
    } else if (state.status === "failed") {
      announce(t(`errors:${state.errorCode ?? "convert_failed"}`, state.errorParams ?? {}));
    } else {
      announce(progressText(t, state));
    }
  }, [state, announce, onReady, t]);

  const busy = send.isPending || state?.status === "pending" || state?.status === "converting";
  return (
    <fieldset className={styles.pdf}>
      <legend>{t("sources:pdf.title")}</legend>
      <TextField
        label={t("sources:pdf.pages")}
        description={t("sources:pdf.pagesHelp")}
        value={pages}
        onChange={setPages}
        errorMessage={pagesError}
        isInvalid={pagesError !== undefined}
        isDisabled={busy}
      />
      <div className={styles.row}>
        <FileTrigger
          acceptedFileTypes={["application/pdf", ".pdf"]}
          onSelect={(files) => {
            const file = files?.[0];
            if (file && !pagesError) send.mutate(file);
          }}
        >
          <Button variant="secondary" isDisabled={busy || pagesError !== undefined}>
            {t("sources:pdf.choose")}
          </Button>
        </FileTrigger>
        {state ? <span>{t("sources:add.chosen", { name: state.filename })}</span> : null}
      </div>
      {state && (state.status === "pending" || state.status === "converting") ? <p>{progressText(t, state)}</p> : null}
      {state?.status === "failed" ? (
        <div>
          <p className={styles.bad} role="alert">
            {t(`errors:${state.errorCode ?? "convert_failed"}`, state.errorParams ?? {})}
          </p>
          <Button variant="secondary" onPress={() => retry.mutate(state.id)} isDisabled={retry.isPending}>
            {t("sources:pdf.retry")}
          </Button>
        </div>
      ) : null}
      {state?.status === "ready" ? (
        <p className={styles.good}>
          <span aria-hidden="true">✓ </span>
          {t("sources:pdf.ready", { name: state.filename, pages: formatNumber(state.pagesConverted ?? 0) })}
        </p>
      ) : null}
      <ErrorMessage error={send.error ?? retry.error} />
    </fieldset>
  );
}
