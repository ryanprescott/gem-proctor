import {
  type SourceFileDetail,
  type SourceFileView,
  sourcesFilesDelete,
  sourcesFilesGet,
  sourcesFilesRetry,
} from "@gem/shared/contracts";
import { useMutation } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { useServerState } from "../api/events.ts";
import { formatDate, formatNumber } from "../format.ts";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";
import { Button, ErrorMessage, errorText } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import styles from "./Sources.module.css";

/** Where a file has got, in words: the pages done once a batch is in. */
export function uploadProgress(t: TFunction, f: SourceFileView): string {
  if (f.status === "pending") return t("sources:uploads.pending");
  if (f.status === "failed") return t(`errors:${f.errorCode ?? "convert_failed"}`, f.errorParams ?? {});
  if (f.status === "ready") return t("sources:uploads.ready", { pages: formatNumber(f.pagesConverted ?? 0) });
  if (f.pagesConverted && f.pageCount) {
    return f.pageRange
      ? t("sources:uploads.convertingSome", { done: formatNumber(f.pagesConverted) })
      : t("sources:uploads.convertingOf", { done: formatNumber(f.pagesConverted), total: formatNumber(f.pageCount) });
  }
  return t("sources:uploads.converting");
}

/**
 * Your PDFs that still need you (SPEC §3C.1): waiting, being read, failed, or read and not yet saved. The list comes
 * over server-sent events (`/sources/files/events`): the server sends it at connect and whenever one of the files
 * changes, so nothing is polled. A file finishing or failing while the page is open is said once; not the one the
 * add-source form is following, which says it itself.
 */
export function SourceUploads({
  following,
  onContinue,
}: {
  following: string | null;
  onContinue: (file: SourceFileDetail) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useLive();
  const [files, setFiles] = useState<SourceFileView[] | null>(null);
  const [removing, setRemoving] = useState<SourceFileView | null>(null);
  const seen = useRef(new Map<string, string>());
  useServerState<{ files: SourceFileView[] }>("/sources/files/events", ({ files }) => setFiles(files));

  useEffect(() => {
    if (!files) return;
    for (const f of files) {
      const before = seen.current.get(f.id);
      seen.current.set(f.id, f.status);
      if (before === undefined || before === f.status || f.id === following) continue;
      if (f.status === "ready") announce(t("sources:uploads.readyAnnounce", { name: f.filename }));
      if (f.status === "failed") announce(t("sources:uploads.failedAnnounce", { name: f.filename }));
    }
  }, [files, following, announce, t]);

  const open = useMutation({
    mutationFn: (id: string) => api.call(sourcesFilesGet, { params: { id } }),
    onSuccess: ({ file }) => onContinue(file),
    onError: (e) => announce(errorText(t, e)),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.call(sourcesFilesRetry, { params: { id } }),
    onError: (e) => announce(errorText(t, e)),
  });
  const remove = useMutation({
    mutationFn: (f: SourceFileView) => api.call(sourcesFilesDelete, { params: { id: f.id } }),
    onSuccess: (_r, f) => {
      setRemoving(null);
      announce(t("sources:uploads.removed", { name: f.filename }));
    },
    onError: (e) => announce(errorText(t, e)),
  });

  if (!files || files.length === 0) return null;
  return (
    <section aria-labelledby="uploads-title">
      <h2 id="uploads-title">{t("sources:uploads.title")}</h2>
      <p>{t("sources:uploads.help")}</p>
      <div className={styles.tableWrap}>
        <table>
          <caption className={styles.caption}>{t("sources:uploads.caption", { count: files.length })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("sources:uploads.colFile")}</th>
              <th scope="col">{t("sources:uploads.colProgress")}</th>
              <th scope="col">{t("sources:uploads.colAdded")}</th>
              <th scope="col">{t("sources:uploads.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <th scope="row">{f.filename}</th>
                <td>{uploadProgress(t, f)}</td>
                <td>{formatDate(f.createdAt)}</td>
                <td>
                  <div className={styles.row}>
                    {f.status === "ready" ? (
                      <Button
                        onPress={() => open.mutate(f.id)}
                        isDisabled={open.isPending}
                        aria-label={t("sources:uploads.continueFor", { name: f.filename })}
                      >
                        {t("sources:uploads.continue")}
                      </Button>
                    ) : null}
                    {f.status === "failed" ? (
                      <Button
                        variant="secondary"
                        onPress={() => retry.mutate(f.id)}
                        isDisabled={retry.isPending}
                        aria-label={t("sources:uploads.retryFor", { name: f.filename })}
                      >
                        {t("sources:pdf.retry")}
                      </Button>
                    ) : null}
                    {f.status !== "converting" ? (
                      <Button
                        variant="secondary"
                        onPress={() => setRemoving(f)}
                        aria-label={t("sources:uploads.removeFor", { name: f.filename })}
                      >
                        {t("sources:uploads.remove")}
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorMessage error={open.error ?? retry.error ?? remove.error} />
      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(isOpen) => !isOpen && setRemoving(null)}
        title={t("sources:uploads.removeTitle", { name: removing?.filename ?? "" })}
        confirmLabel={t("sources:uploads.remove")}
        cancelLabel={t("common:cancel")}
        onConfirm={() => removing && remove.mutate(removing)}
        isPending={remove.isPending}
        variant="danger"
      >
        <p>{t("sources:uploads.removeHelp")}</p>
      </ConfirmDialog>
    </section>
  );
}
