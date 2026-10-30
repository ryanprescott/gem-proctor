import {
  ENDPOINT_LOCATIONS,
  ENDPOINT_SERVERS,
  type EndpointLocation,
  type EndpointServer,
  type LlmEndpoint,
  MODEL_ROLES,
  type ModelInfo,
  type ModelParams,
  type ModelRole,
  type ProbeKind,
  type ProbeResult,
} from "@gem/shared";
import {
  adminLlmEndpointsCreate,
  adminLlmEndpointsDelete,
  adminLlmEndpointsModels,
  adminLlmEndpointsProbe,
  adminLlmEndpointsUpdate,
} from "@gem/shared/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog, Form, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client.ts";
import { formatNumber, formatSeconds } from "../../format.ts";
import { ConfirmDialog } from "../../ui/ConfirmDialog.tsx";
import { Button, Card, ErrorMessage, Select, TextField } from "../../ui/controls.tsx";
import styles from "../Admin.module.css";
import {
  ENDPOINTS_KEY,
  LLM_KEY,
  parseParams,
  type RoleDialogRequest,
  ScrollTable,
  useFeedback,
  useRoleName,
} from "./shared.tsx";

const NO_SERVER = "none";
const COMPATIBLE = "openai-compatible";
const DEFAULT_TIMEOUT_MS = 300_000;

// ── Create and edit ──────────────────────────────────────────────────

function EndpointDialog({
  endpoint,
  providers,
  onClose,
}: {
  endpoint: LlmEndpoint | null;
  providers: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const [label, setLabel] = useState(endpoint?.label ?? "");
  const [provider, setProvider] = useState(endpoint?.provider ?? COMPATIBLE);
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? "");
  const [location, setLocation] = useState<EndpointLocation>(endpoint?.location ?? "local");
  const [server, setServer] = useState<string>(endpoint?.server ?? NO_SERVER);
  const [concurrency, setConcurrency] = useState(String(endpoint?.concurrency ?? 1));
  const [timeoutMs, setTimeoutMs] = useState(String(endpoint?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  // Write-only: the stored key never comes back, so this is only ever a new one.
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        label,
        provider,
        location,
        concurrency: Number(concurrency),
        timeoutMs: Number(timeoutMs),
      };
      const url = baseUrl.trim();
      const chosen = server === NO_SERVER ? null : (server as EndpointServer);
      if (!endpoint) {
        const body = {
          ...fields,
          ...(url ? { baseUrl: url } : {}),
          ...(chosen ? { server: chosen } : {}),
          ...(apiKey ? { apiKey } : {}),
        };
        return (await api.call(adminLlmEndpointsCreate, { body })).endpoint;
      }
      // Only what changed, so the audit log shows real changes (and a key change stays its own entry).
      const all = { ...fields, baseUrl: url || null, server: chosen };
      const changed = Object.fromEntries(
        Object.entries(all).filter(([k, v]) => v !== endpoint[k as keyof LlmEndpoint]),
      );
      const body = { ...changed, ...(clearKey ? { apiKey: null } : apiKey ? { apiKey } : {}) };
      if (Object.keys(body).length === 0) return endpoint;
      return (await api.call(adminLlmEndpointsUpdate, { params: { id: endpoint.id }, body })).endpoint;
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: LLM_KEY });
      feedback.done(t("admin:llm.endpoints.saved", { label: saved.label }));
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
              save.mutate();
            }}
          >
            <Heading slot="title">
              {endpoint ? t("admin:llm.endpoints.editTitle", { label: endpoint.label }) : t("admin:llm.endpoints.new")}
            </Heading>
            <TextField label={t("admin:llm.endpoints.label")} value={label} onChange={setLabel} isRequired autoFocus />
            <Select
              label={t("admin:llm.endpoints.provider")}
              selectedKey={provider}
              onSelectionChange={(p) => {
                setProvider(p);
                if (!endpoint) setLocation(p === COMPATIBLE ? "local" : "cloud");
              }}
              options={providers.map((p) => ({ id: p, label: p }))}
            />
            <TextField
              label={t("admin:llm.endpoints.baseUrl")}
              description={t("admin:llm.endpoints.baseUrlHelp")}
              inputType="url"
              value={baseUrl}
              onChange={setBaseUrl}
              isRequired={provider === COMPATIBLE}
            />
            <Select
              label={t("admin:llm.endpoints.location")}
              selectedKey={location}
              onSelectionChange={(l) => setLocation(l as EndpointLocation)}
              options={ENDPOINT_LOCATIONS.map((l) => ({ id: l, label: t(`admin:llm.locations.${l}`) }))}
            />
            <Select
              label={t("admin:llm.endpoints.server")}
              selectedKey={server}
              onSelectionChange={setServer}
              options={[
                { id: NO_SERVER, label: t("admin:llm.endpoints.serverNone") },
                ...ENDPOINT_SERVERS.map((s) => ({ id: s, label: s })),
              ]}
            />
            <div className={styles.fieldRow}>
              <TextField
                label={t("admin:llm.endpoints.concurrency")}
                inputType="number"
                value={concurrency}
                onChange={setConcurrency}
                isRequired
              />
              <TextField
                label={t("admin:llm.endpoints.timeoutMs")}
                inputType="number"
                value={timeoutMs}
                onChange={setTimeoutMs}
                isRequired
              />
            </div>
            <TextField
              label={endpoint?.hasKey ? t("admin:llm.endpoints.newKey") : t("admin:llm.endpoints.apiKey")}
              description={t("admin:llm.endpoints.keyHelp")}
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(v) => {
                setApiKey(v);
                setClearKey(false);
              }}
            />
            {endpoint?.hasKey ? (
              <div className={styles.keyState}>
                <span>{clearKey ? t("admin:llm.endpoints.keyWillClear") : t("admin:llm.endpoints.keySet")}</span>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setClearKey(!clearKey);
                    setApiKey("");
                  }}
                >
                  {clearKey ? t("admin:llm.endpoints.keepKey") : t("admin:llm.endpoints.clearKey")}
                </Button>
              </div>
            ) : null}
            <ErrorMessage error={save.error} />
            <div className={styles.dialogActions}>
              <Button variant="secondary" onPress={onClose}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" isDisabled={save.isPending}>
                {t("admin:llm.endpoints.save")}
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// ── Models and probe ─────────────────────────────────────────────────

function ModelsTable({ models, onPick }: { models: ModelInfo[]; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  if (models.length === 0) return <p>{t("admin:llm.models.none")}</p>;
  return (
    <ScrollTable label={t("admin:llm.models.title")}>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("admin:llm.models.colModel")}</th>
            <th scope="col">{t("admin:llm.models.colContext")}</th>
            <th scope="col">{t("admin:llm.models.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <th scope="row">{m.id}</th>
              <td>{m.contextLength === null ? t("admin:llm.notReported") : formatNumber(m.contextLength)}</td>
              <td>
                <Button
                  variant="secondary"
                  aria-label={t("admin:llm.models.pickFor", { model: m.id })}
                  onPress={() => onPick(m.id)}
                >
                  {t("admin:llm.models.pick")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function ProbeReport({ result }: { result: ProbeResult }) {
  const { t } = useTranslation();
  const context = result.reportedContext === null ? t("admin:llm.notReported") : formatNumber(result.reportedContext);
  if (result.kind === "embeddings") {
    return (
      <dl>
        <dt>{t("admin:llm.probe.dimensions")}</dt>
        <dd>{formatNumber(result.dimensions)}</dd>
        <dt>{t("admin:llm.probe.maxInputTokens")}</dt>
        <dd>{formatNumber(result.maxInputTokens)}</dd>
        <dt>{t("admin:llm.probe.latency")}</dt>
        <dd>{formatSeconds(result.latencyMs)}</dd>
        <dt>{t("admin:llm.probe.requests")}</dt>
        <dd>{formatNumber(result.requests)}</dd>
        <dt>{t("admin:llm.probe.reportedContext")}</dt>
        <dd>{context}</dd>
      </dl>
    );
  }
  return (
    <>
      <ScrollTable label={t("admin:llm.probe.results")}>
        <table>
          <thead>
            <tr>
              <th scope="col">{t("admin:llm.probe.colMode")}</th>
              <th scope="col">{t("admin:llm.probe.colRespected")}</th>
              <th scope="col">{t("admin:llm.probe.latency")}</th>
              <th scope="col">{t("admin:llm.probe.colFinish")}</th>
            </tr>
          </thead>
          <tbody>
            {result.modes.map((m) => (
              <tr key={m.mode}>
                <th scope="row">{t(`admin:llm.modes.${m.mode}`)}</th>
                <td>
                  {m.schemaRespected === null
                    ? t("admin:llm.probe.cutOff")
                    : m.schemaRespected
                      ? t("admin:llm.probe.yes")
                      : t("admin:llm.probe.no")}
                  {m.errorCode ? <div className={styles.muted}>{t(`errors:${m.errorCode}`)}</div> : null}
                </td>
                <td>{formatSeconds(m.latencyMs)}</td>
                <td>{m.finishReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <p>{t("admin:llm.probe.contextLine", { context })}</p>
    </>
  );
}

const CHAT_ROLES = MODEL_ROLES.filter((r) => r !== "embeddings");

/** The role dialog's starting values from a probe; null when the probe gave nothing usable. */
function probeValues(endpoint: LlmEndpoint, model: string, result: ProbeResult, params?: ModelParams) {
  if (result.kind === "embeddings") {
    const { dimensions, maxInputTokens, reportedContext } = result;
    return {
      endpointId: endpoint.id,
      model,
      params,
      dimensions,
      maxInputTokens,
      ...(reportedContext === null ? {} : { contextWindow: reportedContext }),
    };
  }
  const mode = result.modes.find((m) => m.schemaRespected);
  if (!mode) return null;
  const context = result.reportedContext;
  return {
    endpointId: endpoint.id,
    model,
    params,
    structuredOutput: mode.mode,
    ...(context === null ? {} : { contextWindow: context }),
  };
}

function EndpointTools({
  endpoint,
  onAssign,
}: {
  endpoint: LlmEndpoint;
  onAssign: (request: RoleDialogRequest) => void;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const roleName = useRoleName();
  const [model, setModel] = useState("");
  const [kind, setKind] = useState<ProbeKind>("chat");
  const [paramsText, setParamsText] = useState("");
  const params = parseParams(paramsText);
  const [role, setRole] = useState<ModelRole>(CHAT_ROLES[0] as ModelRole);
  const models = useMutation({
    mutationFn: () => api.call(adminLlmEndpointsModels, { params: { id: endpoint.id } }),
    onSuccess: (r) => feedback.done(t("admin:llm.models.found", { count: r.models.length })),
    onError: feedback.failed,
  });
  const probe = useMutation({
    mutationFn: (input: { model: string; kind: ProbeKind; params?: ModelParams }) =>
      api.call(adminLlmEndpointsProbe, { params: { id: endpoint.id }, body: input }),
    onSuccess: () => feedback.done(t("admin:llm.probe.done")),
    onError: feedback.failed,
  });
  // The probed model and kind, not whatever the form holds by the time the result is used.
  const probed = probe.variables;
  const values = probe.data && probed ? probeValues(endpoint, probed.model, probe.data, probed.params) : null;
  const target = probed?.kind === "embeddings" ? "embeddings" : role;
  const cutOff = probe.data?.kind === "chat" && probe.data.modes.some((m) => m.schemaRespected === null);

  return (
    <section>
      <h3>{t("admin:llm.tools.title", { label: endpoint.label })}</h3>
      <Button variant="secondary" onPress={() => models.mutate()} isDisabled={models.isPending}>
        {t("admin:llm.models.list")}
      </Button>
      <ErrorMessage error={models.error} />
      {models.data ? <ModelsTable models={models.data.models} onPick={setModel} /> : null}
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          if (params !== null) probe.mutate({ model, kind, ...(params ? { params } : {}) });
        }}
      >
        <div className={styles.fieldRow}>
          <TextField label={t("admin:llm.probe.model")} value={model} onChange={setModel} isRequired />
          <Select
            label={t("admin:llm.probe.kind")}
            selectedKey={kind}
            onSelectionChange={(k) => setKind(k as ProbeKind)}
            options={[
              { id: "chat", label: t("admin:llm.probe.kindChat") },
              { id: "embeddings", label: t("admin:llm.probe.kindEmbeddings") },
            ]}
          />
        </div>
        <TextField
          label={t("admin:llm.roles.params")}
          description={t("admin:llm.probe.paramsHelp")}
          multiline
          rows={2}
          value={paramsText}
          onChange={setParamsText}
          isInvalid={params === null}
          errorMessage={t("admin:llm.roles.paramsInvalid")}
        />
        <Button type="submit" isDisabled={probe.isPending}>
          {probe.isPending ? t("admin:llm.probe.running") : t("admin:llm.probe.run")}
        </Button>
      </Form>
      <ErrorMessage error={probe.error} />
      {probe.data ? (
        <>
          <h4>{t("admin:llm.probe.results")}</h4>
          <ProbeReport result={probe.data} />
          {values ? (
            <div className={styles.fieldRow}>
              {probed?.kind === "chat" ? (
                <Select
                  label={t("admin:llm.probe.forRole")}
                  selectedKey={role}
                  onSelectionChange={(r) => setRole(r as ModelRole)}
                  options={CHAT_ROLES.map((r) => ({ id: r, label: roleName(r) }))}
                />
              ) : null}
              <Button onPress={() => onAssign({ role: target, prefill: values })}>{t("admin:llm.probe.use")}</Button>
            </div>
          ) : (
            <p>{cutOff ? t("admin:llm.probe.cutOffHelp") : t("admin:llm.probe.unusable")}</p>
          )}
        </>
      ) : null}
    </section>
  );
}

// ── The list ─────────────────────────────────────────────────────────

export function EndpointsCard({
  endpoints,
  providers,
  onAssign,
}: {
  endpoints: LlmEndpoint[];
  providers: string[];
  onAssign: (request: RoleDialogRequest) => void;
}) {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ endpoint: LlmEndpoint | null } | null>(null);
  const [deleting, setDeleting] = useState<LlmEndpoint | null>(null);
  const [toolsId, setToolsId] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (e: LlmEndpoint) => api.call(adminLlmEndpointsDelete, { params: { id: e.id } }),
    onSuccess: async (_r, e) => {
      await qc.invalidateQueries({ queryKey: ENDPOINTS_KEY });
      feedback.done(t("admin:llm.endpoints.deleted", { label: e.label }));
      setDeleting(null);
      if (toolsId === e.id) setToolsId(null);
    },
    onError: feedback.failed,
  });
  const tools = endpoints.find((e) => e.id === toolsId);

  return (
    <Card title={t("admin:llm.endpoints.title")}>
      <Button onPress={() => setDialog({ endpoint: null })}>{t("admin:llm.endpoints.new")}</Button>
      {endpoints.length === 0 ? (
        <p>{t("admin:llm.endpoints.empty")}</p>
      ) : (
        <ScrollTable label={t("admin:llm.endpoints.title")}>
          <table>
            <thead>
              <tr>
                <th scope="col">{t("admin:llm.endpoints.label")}</th>
                <th scope="col">{t("admin:llm.endpoints.colConnection")}</th>
                <th scope="col">{t("admin:llm.endpoints.location")}</th>
                <th scope="col">{t("admin:llm.endpoints.colKey")}</th>
                <th scope="col">{t("admin:llm.endpoints.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((e) => (
                <tr key={e.id}>
                  <th scope="row">{e.label}</th>
                  <td>
                    {e.provider}
                    {e.server ? ` · ${e.server}` : null}
                    <div className={styles.muted}>{e.baseUrl}</div>
                  </td>
                  <td>{t(`admin:llm.locations.${e.location}`)}</td>
                  <td>{e.hasKey ? t("admin:llm.endpoints.keySet") : t("admin:llm.endpoints.noKey")}</td>
                  <td className={styles.rowActions}>
                    <Button
                      variant="secondary"
                      aria-label={t("admin:llm.endpoints.toolsFor", { label: e.label })}
                      onPress={() => setToolsId(e.id)}
                    >
                      {t("admin:llm.endpoints.tools")}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={t("admin:llm.endpoints.editFor", { label: e.label })}
                      onPress={() => setDialog({ endpoint: e })}
                    >
                      {t("admin:llm.endpoints.edit")}
                    </Button>
                    <Button
                      variant="danger"
                      aria-label={t("admin:llm.endpoints.deleteFor", { label: e.label })}
                      onPress={() => {
                        remove.reset();
                        setDeleting(e);
                      }}
                    >
                      {t("admin:llm.endpoints.delete")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      )}
      {tools ? <EndpointTools key={tools.id} endpoint={tools} onAssign={onAssign} /> : null}
      {dialog ? (
        <EndpointDialog endpoint={dialog.endpoint} providers={providers} onClose={() => setDialog(null)} />
      ) : null}
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("admin:llm.endpoints.deleteTitle", { label: deleting?.label })}
        confirmLabel={t("admin:llm.endpoints.delete")}
        cancelLabel={t("common:cancel")}
        onConfirm={() => deleting && remove.mutate(deleting)}
        isPending={remove.isPending}
        variant="danger"
      >
        <p>{t("admin:llm.endpoints.deleteHelp")}</p>
        <ErrorMessage error={remove.error} />
      </ConfirmDialog>
    </Card>
  );
}
