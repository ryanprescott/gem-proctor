import type { RoleAssignmentView } from "@gem/shared";
import { adminGetSettings, adminLlmEndpointsList, adminLlmRolesList, adminPutSettings } from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Switch } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { Card, ErrorMessage } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";
import styles from "./Admin.module.css";
import { EndpointsCard } from "./llm/Endpoints.tsx";
import { EvalsCard } from "./llm/Evals.tsx";
import { RoleDialog, RolesCard } from "./llm/Roles.tsx";
import { StatsCard } from "./llm/Stats.tsx";
import { ENDPOINTS_KEY, ROLES_KEY, type RoleDialogRequest, useFeedback, useRoleName } from "./llm/shared.tsx";

const SETTINGS_KEY = ["admin", "settings"];

/** Every role on a cloud endpoint is named: its text leaves the instance (SPEC §3B.2, §1.3). */
function CloudNotices({ roles }: { roles: RoleAssignmentView[] }) {
  const { t } = useTranslation();
  const roleName = useRoleName();
  const cloud = roles.flatMap(({ role, assignment }) =>
    assignment?.location === "cloud" ? [{ role, endpoint: assignment.endpointLabel }] : [],
  );
  return cloud.map(({ role, endpoint }) => (
    <p key={role} className={styles.notice}>
      {t("admin:llm.cloudNotice", { role: roleName(role), endpoint })}
    </p>
  ));
}

function LocalOnlyCard() {
  const { t } = useTranslation();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.call(adminGetSettings) });
  const settings = query.data?.settings;
  const save = useMutation({
    mutationFn: (localEndpointsOnly: boolean) =>
      api.call(adminPutSettings, {
        body: { selfRegistration: settings?.selfRegistration ?? true, localEndpointsOnly },
      }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      feedback.done(
        r.settings.localEndpointsOnly ? t("admin:llm.localOnly.turnedOn") : t("admin:llm.localOnly.turnedOff"),
      );
    },
    onError: feedback.failed,
  });
  if (!settings) return <ErrorMessage error={query.error} />;
  return (
    <Card title={t("admin:llm.localOnly.title")}>
      <Switch
        isSelected={settings.localEndpointsOnly}
        onChange={(on) => save.mutate(on)}
        isDisabled={save.isPending}
        className={styles.switch}
      >
        <span className={styles.track} aria-hidden="true">
          <span className={styles.thumb} />
        </span>
        {t("admin:llm.localOnly.label")}
      </Switch>
      <p className={styles.muted}>
        {settings.localEndpointsOnly ? t("admin:llm.localOnly.on") : t("admin:llm.localOnly.off")}
      </p>
      <ErrorMessage error={save.error} />
    </Card>
  );
}

function LlmPage() {
  const { t } = useTranslation();
  const endpoints = useQuery({ queryKey: ENDPOINTS_KEY, queryFn: () => api.call(adminLlmEndpointsList) });
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: () => api.call(adminLlmRolesList) });
  const [roleDialog, setRoleDialog] = useState<RoleDialogRequest | null>(null);
  if (endpoints.isPending || roles.isPending) return <p>{t("common:loading")}</p>;
  if (!endpoints.data || !roles.data) return <ErrorMessage error={endpoints.error ?? roles.error} />;
  const views = roles.data.roles;
  return (
    <>
      <CloudNotices roles={views} />
      <LocalOnlyCard />
      <EndpointsCard
        endpoints={endpoints.data.endpoints}
        providers={endpoints.data.providers}
        onAssign={setRoleDialog}
      />
      <RolesCard roles={views} canAssign={endpoints.data.endpoints.length > 0} onAssign={setRoleDialog} />
      <StatsCard />
      <EvalsCard />
      {roleDialog ? (
        <RoleDialog
          key={roleDialog.role}
          request={roleDialog}
          current={views.find((v) => v.role === roleDialog.role)?.assignment ?? null}
          endpoints={endpoints.data.endpoints}
          onClose={() => setRoleDialog(null)}
        />
      ) : null}
    </>
  );
}

export function AdminLlmPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin:llm.title"));
  return (
    <RequireRole minRole="admin">
      {() => (
        <>
          <h1>{t("admin:llm.title")}</h1>
          <LlmPage />
        </>
      )}
    </RequireRole>
  );
}
