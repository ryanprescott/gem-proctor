import { PAGE_RANGE_PATTERN } from "@gem/shared";
import { sourcesFilesCreate } from "@gem/shared/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FileTrigger } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { Button, ErrorMessage, errorText, TextField } from "../ui/controls.tsx";
import { useLive } from "../ui/live.tsx";
import styles from "./Sources.module.css";

const PAGES = new RegExp(PAGE_RANGE_PATTERN);

/**
 * Adding PDFs (SPEC §3C.1): one or several, each with the page range given, uploaded one after another. That's all it
 * does: they're read in the background and followed in the list of PDFs, and nothing reaches the add-source form until
 * the creator makes a source from one.
 */
export function PdfUploader() {
  const { t } = useTranslation();
  const { announce } = useLive();
  const [pages, setPages] = useState("");
  const pagesError = pages.trim() !== "" && !PAGES.test(pages.trim()) ? t("sources:pdf.pagesInvalid") : undefined;

  const send = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await api.upload(sourcesFilesCreate, {
          query: { filename: file.name, ...(pages.trim() ? { pageRange: pages.trim() } : {}) },
          file: new File([file], file.name, { type: "application/pdf" }),
        });
      }
      return files.length;
    },
    onSuccess: (count) => announce(t("sources:pdf.added", { count })),
    onError: (e) => announce(errorText(t, e)),
  });

  return (
    <div className={styles.pdf}>
      <TextField
        label={t("sources:pdf.pages")}
        description={t("sources:pdf.pagesHelp")}
        value={pages}
        onChange={setPages}
        errorMessage={pagesError}
        isInvalid={pagesError !== undefined}
        isDisabled={send.isPending}
      />
      <FileTrigger
        acceptedFileTypes={["application/pdf", ".pdf"]}
        allowsMultiple
        onSelect={(list) => {
          const files = [...(list ?? [])];
          if (files.length > 0 && !pagesError) send.mutate(files);
        }}
      >
        <Button variant="secondary" isDisabled={send.isPending || pagesError !== undefined}>
          {t("sources:pdf.choose")}
        </Button>
      </FileTrigger>
      <ErrorMessage error={send.error} />
    </div>
  );
}
