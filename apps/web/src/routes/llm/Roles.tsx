import {
  type LlmEndpoint,
  type ModelRole,
  type RoleAssignmentView,
  STRUCTURED_MODES,
  type StructuredMode,
} from "@gem/shared";
import { adminLlmRolesDelete, adminLlmRolesPut } from "@gem/shared/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, Form, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client.ts";
import { formatNumber } from "../../format.ts";
import { ConfirmDialog } from "../../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, Select, TextField } from "../../ui/controls.tsx";
import styles from "../Admin.module.css";
import {
  LLM_KEY,
  parseParams,
  ROLES_KEY,
  type RoleDialogRequest,
  ScrollTable,
  useFeedback,
  useRoleName,
} from "./shared.tsx";

/** The share of the context a new assignment keeps for output, as the dev seed does. */
const OUTPUT_SHARE = 4;

const numberText = (n: number | undefined) => (n === undefined ? "" : String(n));

export function RoleDialog({
  request,
  current,
  endpoints,
  onClose,
}: {
  request: RoleDialogRequest;
  current: RoleAssignmentView["assignment"];
  endpoints: LlmEndpoint[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const roleName = useRoleName();
  const qc = useQueryClient();
  const { role, prefill } = request;
  const isEmbeddings = role === "embeddings";
  const capabilities = current?.capabilities;
  const startContext = prefill?.contextWindow ?? prefill?.maxInputTokens ?? capabilities?.contextWindow;
  const [endpointId, setEndpointId] = useState(prefill?.endpointId ?? current?.endpointId ?? endpoints[0]?.id ?? "");
  const [model, setModel] = useState(prefill?.model ?? current?.model ?? "");
  const [mode, setMode] = useState<StructuredMode>(
    prefill?.structuredOutput ?? capabilities?.structuredOutput ?? "native_schema",
  );
  const [contextWindow, setContextWindow] = useState(numberText(startContext));
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    numberText(
      capabilities?.maxOutputTokens ??
        (startContext === undefined ? undefined : Math.floor(startContext / OUTPUT_SHARE)),
    ),
  );
  const [maxInputTokens, setMaxInputTokens] = useState(
    numberText(prefill?.maxInputTokens ?? capabilities?.maxInputTokens),
  );
  const [dimensions, setDimensions] = useState(numberText(prefill?.dimensions ?? current?.embedding?.dimensions));
  const [queryPrefix, setQueryPrefix] = useState(current?.embedding?.queryPrefix ?? "");
  const [documentPrefix, setDocumentPrefix] = useState(current?.embedding?.documentPrefix ?? "");
  const [paramsText, setParamsText] = useState(() => {
    const start = prefill?.params ?? current?.params;
    return start ? JSON.stringify(start, null, 2) : "";
  });
  const params = parseParams(paramsText);

  const save = useMutation({
    mutationFn: () =>
      api.call(adminLlmRolesPut, {
        params: { role },
        body: {
          endpointId,
          model,
          capabilities: {
            structuredOutput: mode,
            contextWindow: Number(contextWindow),
            maxOutputTokens: Number(maxOutputTokens),
            ...(isEmbeddings ? { maxInputTokens: Number(maxInputTokens) } : {}),
          },
          ...(isEmbeddings ? { embedding: { dimensions: Number(dimensions), queryPrefix, documentPrefix } } : {}),
          ...(params ? { params } : {}),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: LLM_KEY });
      feedback.done(t("admin:llm.roles.saved", { role: roleName(role) }));
      onClose();
    },
    onError: feedback.failed,
  });

  return (
    <ModalOverlay className={styles.overlay} isOpen onOpenChange={(open) => !open && onClose()} isDismissable>
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              if (params !== null) save.mutate();
            }}
          >
            <Heading slot="title">{t("admin:llm.roles.dialogTitle", { role: roleName(role) })}</Heading>
            {prefill ? <p>{t("admin:llm.roles.fromProbe")}</p> : null}
            <Select
              label={t("admin:llm.roles.colEndpoint")}
              selectedKey={endpointId}
              onSelectionChange={setEndpointId}
              options={endpoints.map((e) => ({ id: e.id, label: e.label }))}
            />
            <TextField label={t("admin:llm.roles.colModel")} value={model} onChange={setModel} isRequired autoFocus />
            <Select
              label={t("admin:llm.roles.colMode")}
              selectedKey={mode}
              onSelectionChange={(m) => setMode(m as StructuredMode)}
              options={STRUCTURED_MODES.map((m) => ({ id: m, label: t(`admin:llm.modes.${m}`) }))}
            />
            <div className={styles.fieldRow}>
              <TextField
                label={t("admin:llm.roles.colContext")}
                inputType="number"
                value={contextWindow}
                onChange={setContextWindow}
                isRequired
              />
              <TextField
                label={t("admin:llm.roles.maxOutputTokens")}
                inputType="number"
                value={maxOutputTokens}
                onChange={setMaxOutputTokens}
                isRequired
              />
            </div>
            {isEmbeddings ? (
              <>
                <div className={styles.fieldRow}>
                  <TextField
                    label={t("admin:llm.probe.maxInputTokens")}
                    inputType="number"
                    value={maxInputTokens}
                    onChange={setMaxInputTokens}
                    isRequired
                  />
                  <TextField
                    label={t("admin:llm.probe.dimensions")}
                    inputType="number"
                    value={dimensions}
                    onChange={setDimensions}
                    isRequired
                  />
                </div>
                <TextField label={t("admin:llm.roles.queryPrefix")} value={queryPrefix} onChange={setQueryPrefix} />
                <TextField
                  label={t("admin:llm.roles.documentPrefix")}
                  value={documentPrefix}
                  onChange={setDocumentPrefix}
                />
              </>
            ) : null}
            <TextField
              label={t("admin:llm.roles.params")}
              description={t("admin:llm.roles.paramsHelp")}
              multiline
              rows={4}
              value={paramsText}
              onChange={setParamsText}
              isInvalid={params === null}
              errorMessage={t("admin:llm.roles.paramsInvalid")}
            />
            <ErrorMessage error={save.error} />
            <div className={styles.dialogActions}>
              <Button variant="secondary" onPress={onClose}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" isDisabled={save.isPending}>
                {t("admin:llm.roles.save")}
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function RolesCard({
  roles,
  canAssign,
  onAssign,
}: {
  roles: RoleAssignmentView[];
  canAssign: boolean;
  onAssign: (request: RoleDialogRequest) => void;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const roleName = useRoleName();
  const qc = useQueryClient();
  const [unassigning, setUnassigning] = useState<ModelRole | null>(null);
  const unassign = useMutation({
    mutationFn: (role: ModelRole) => api.call(adminLlmRolesDelete, { params: { role } }),
    onSuccess: async (_r, role) => {
      await qc.invalidateQueries({ queryKey: ROLES_KEY });
      feedback.done(t("admin:llm.roles.unassigned", { role: roleName(role) }));
      setUnassigning(null);
    },
    onError: feedback.failed,
  });
  return (
    <Card title={t("admin:llm.roles.title")}>
      {canAssign ? null : <p>{t("admin:llm.roles.noEndpoints")}</p>}
      <ScrollTable label={t("admin:llm.roles.title")}>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("admin:llm.roles.colRole")}</th>
              <th scope="col">{t("admin:llm.roles.colEndpoint")}</th>
              <th scope="col">{t("admin:llm.roles.colModel")}</th>
              <th scope="col">{t("admin:llm.roles.colMode")}</th>
              <th scope="col">{t("admin:llm.roles.colContext")}</th>
              <th scope="col">{t("admin:llm.roles.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {roles.map(({ role, assignment: a }) => (
              <tr key={role}>
                <th scope="row">{roleName(role)}</th>
                {a ? (
                  <>
                    <td>
                      {a.endpointLabel}{" "}
                      {a.location === "cloud" ? (
                        <span className={styles.badge}>{t("admin:llm.locations.cloud")}</span>
                      ) : null}
                    </td>
                    <td>{a.model}</td>
                    <td>{t(`admin:llm.modes.${a.capabilities.structuredOutput}`)}</td>
                    <td>{formatNumber(a.capabilities.contextWindow)}</td>
                  </>
                ) : (
                  <td colSpan={4}>{t("admin:llm.roles.notAssigned")}</td>
                )}
                <td className={styles.rowActions}>
                  <Button
                    variant="secondary"
                    aria-label={
                      a
                        ? t("admin:llm.roles.editFor", { role: roleName(role) })
                        : t("admin:llm.roles.assignFor", { role: roleName(role) })
                    }
                    isDisabled={!canAssign}
                    onPress={() => onAssign({ role })}
                  >
                    {a ? t("admin:llm.roles.edit") : t("admin:llm.roles.assign")}
                  </Button>
                  {a ? (
                    <Button
                      variant="danger"
                      aria-label={t("admin:llm.roles.unassignFor", { role: roleName(role) })}
                      onPress={() => {
                        unassign.reset();
                        setUnassigning(role);
                      }}
                    >
                      {t("admin:llm.roles.unassign")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <ConfirmDialog
        isOpen={unassigning !== null}
        onOpenChange={(open) => !open && setUnassigning(null)}
        title={t("admin:llm.roles.unassignTitle", { role: unassigning ? roleName(unassigning) : "" })}
        confirmLabel={t("admin:llm.roles.unassign")}
        cancelLabel={t("common:cancel")}
        onConfirm={() => unassigning && unassign.mutate(unassigning)}
        isPending={unassign.isPending}
        variant="danger"
      >
        <p>{t("admin:llm.roles.unassignHelp")}</p>
        <ErrorMessage error={unassign.error} />
      </ConfirmDialog>
    </Card>
  );
}
