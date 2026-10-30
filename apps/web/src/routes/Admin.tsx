import {
  type AdminUser,
  AUDIT_ACTIONS,
  AUDIT_TARGETS,
  type AuditAction,
  adminAuditLog,
  adminAuditLogCsv,
  adminDisableUser,
  adminGetSettings,
  adminPutSettings,
  adminResetPassword,
  adminSetRoles,
  adminUsers,
  ROLES,
  type Role,
} from "@gem/shared/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Dialog, DialogTrigger, Form, Heading, Modal, ModalOverlay, Switch } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api, contractUrl } from "../api/client.ts";
import { RequireRole } from "../auth.tsx";
import { formatDate, formatDateTime, formatNumber } from "../format.ts";
import { Button, Card, ErrorMessage, errorText, Select, TextField } from "../ui/controls.tsx";
import { useDocumentTitle, useLive } from "../ui/live.tsx";
import styles from "./Admin.module.css";

// ── Users ────────────────────────────────────────────────────────────

function ResetPasswordDialog({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const { announce, notify } = useLive();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => api.call(adminResetPassword, { params: { id: user.id }, body: { password } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
      const message = t("admin:users.resetDone", { email: user.email });
      announce(message);
      notify(message);
      setPassword("");
    },
    onError: (e) => announce(errorText(t, e)),
  });
  return (
    <DialogTrigger>
      <Button variant="secondary">{t("admin:users.reset")}</Button>
      <ModalOverlay className={styles.overlay} isDismissable>
        <Modal className={styles.modal}>
          <Dialog className={styles.dialog}>
            {({ close }) => (
              <Form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await reset.mutateAsync().then(close, () => undefined);
                }}
              >
                <Heading slot="title">{t("admin:users.resetTitle", { email: user.email })}</Heading>
                <p>{t("admin:users.resetHelp")}</p>
                <TextField
                  label={t("admin:users.newPassword")}
                  description={t("auth:passwordRules")}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={setPassword}
                  isRequired
                  autoFocus
                />
                <ErrorMessage error={reset.error} />
                <div className={styles.dialogActions}>
                  <Button variant="secondary" onPress={close}>
                    {t("common:cancel")}
                  </Button>
                  <Button type="submit" isDisabled={reset.isPending}>
                    {t("admin:users.resetSubmit")}
                  </Button>
                </div>
              </Form>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function UserRow({ user, self }: { user: AdminUser; self: boolean }) {
  const { t } = useTranslation();
  const { announce, notify } = useLive();
  const qc = useQueryClient();
  const onDone = async (message: string) => {
    await qc.invalidateQueries({ queryKey: ["admin", "users"] });
    announce(message);
    notify(message);
  };
  const onError = (e: unknown) => {
    const message = errorText(t, e);
    announce(message);
    notify(message, "error");
  };
  const setRole = useMutation({
    mutationFn: (role: Role) => api.call(adminSetRoles, { params: { id: user.id }, body: { role } }),
    onSuccess: (r) =>
      onDone(t("admin:users.roleChanged", { email: user.email, role: t(`common:roles.${r.user.role}`) })),
    onError,
  });
  const disable = useMutation({
    mutationFn: (disabled: boolean) => api.call(adminDisableUser, { params: { id: user.id }, body: { disabled } }),
    onSuccess: (r) =>
      onDone(t(r.user.disabledAt ? "admin:users.disabledDone" : "admin:users.enabledDone", { email: user.email })),
    onError,
  });
  const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();
  return (
    <tr>
      <th scope="row">
        {user.displayName}
        <div className={styles.muted}>{user.email}</div>
      </th>
      <td>
        <Select
          label={t("admin:users.roleFor", { email: user.email })}
          selectedKey={user.role}
          onSelectionChange={(k) => setRole.mutate(k as Role)}
          isDisabled={setRole.isPending}
          options={ROLES.map((r) => ({ id: r, label: t(`common:roles.${r}`) }))}
        />
      </td>
      <td>
        {user.disabledAt
          ? t("admin:users.statusDisabled", { date: formatDate(user.disabledAt) })
          : t("admin:users.statusActive")}
        {locked ? (
          <div className={styles.warning}>{t("admin:users.locked", { date: formatDateTime(user.lockedUntil) })}</div>
        ) : null}
      </td>
      <td>{formatDate(user.createdAt)}</td>
      <td className={styles.rowActions}>
        <ResetPasswordDialog user={user} />
        {self ? null : (
          <Button
            variant={user.disabledAt ? "secondary" : "danger"}
            onPress={() => disable.mutate(!user.disabledAt)}
            isDisabled={disable.isPending}
          >
            {user.disabledAt ? t("admin:users.enable") : t("admin:users.disable")}
          </Button>
        )}
      </td>
    </tr>
  );
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin:users.title"));
  return (
    <RequireRole minRole="admin">
      {(me) => (
        <>
          <h1>{t("admin:users.title")}</h1>
          <UsersTable meId={me.id} />
        </>
      )}
    </RequireRole>
  );
}

function UsersTable({ meId }: { meId: string }) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.call(adminUsers) });
  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (!query.data) return <ErrorMessage error={query.error} />;
  return (
    <div className={styles.tableWrap}>
      <table>
        <caption className={styles.caption}>{t("admin:users.caption", { count: query.data.users.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("admin:users.colUser")}</th>
            <th scope="col">{t("admin:users.colRole")}</th>
            <th scope="col">{t("admin:users.colStatus")}</th>
            <th scope="col">{t("admin:users.colCreated")}</th>
            <th scope="col">{t("admin:users.colActions")}</th>
          </tr>
        </thead>
        <tbody>
          {query.data.users.map((u) => (
            <UserRow key={u.id} user={u} self={u.id === meId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────

function SettingsForm() {
  const { t } = useTranslation();
  const { announce, notify } = useLive();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["admin", "settings"], queryFn: () => api.call(adminGetSettings) });
  const [selfRegistration, setSelfRegistration] = useState(true);
  useEffect(() => {
    if (query.data) setSelfRegistration(query.data.settings.selfRegistration);
  }, [query.data]);
  const save = useMutation({
    mutationFn: () => api.call(adminPutSettings, { body: { selfRegistration } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "settings"] });
      const message = t("admin:settings.saved");
      announce(message);
      notify(message);
    },
    onError: (e) => announce(errorText(t, e)),
  });
  if (query.isPending) return <p>{t("common:loading")}</p>;
  if (!query.data) return <ErrorMessage error={query.error} />;
  return (
    <Card>
      <Form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Switch isSelected={selfRegistration} onChange={setSelfRegistration} className={styles.switch}>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.thumb} />
          </span>
          {t("admin:settings.selfRegistration")}
        </Switch>
        <p className={styles.muted}>
          {selfRegistration ? t("admin:settings.selfRegistrationOn") : t("admin:settings.selfRegistrationOff")}
        </p>
        <ErrorMessage error={save.error} />
        <Button type="submit" isDisabled={save.isPending}>
          {t("admin:settings.save")}
        </Button>
      </Form>
    </Card>
  );
}

export function AdminSettingsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin:settings.title"));
  return (
    <RequireRole minRole="admin">
      {() => (
        <>
          <h1>{t("admin:settings.title")}</h1>
          <SettingsForm />
        </>
      )}
    </RequireRole>
  );
}

// ── Audit log ────────────────────────────────────────────────────────

const PAGE = 50;

function json(v: unknown): string {
  return v === null || v === undefined ? "" : JSON.stringify(v);
}

/** `yyyy-mm-dd` from a date input → ISO bounds for that local day. */
export function dayStart(d: string): string | undefined {
  return d ? new Date(`${d}T00:00:00`).toISOString() : undefined;
}
function dayEnd(d: string): string | undefined {
  return d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined;
}

function AuditLogView() {
  const { t } = useTranslation();
  const { announce } = useLive();
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: () => api.call(adminUsers) });
  const [actorId, setActorId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const filter = {
    actorId: actorId || undefined,
    action: (action || undefined) as AuditAction | undefined,
    from: dayStart(from),
    to: dayEnd(to),
  };
  const query = useQuery({
    queryKey: ["admin", "audit", filter, offset],
    queryFn: () => api.call(adminAuditLog, { query: { ...filter, limit: PAGE, offset } }),
  });
  useEffect(() => {
    if (query.data) announce(t("admin:audit.results", { count: query.data.total }));
  }, [query.data, announce, t]);

  return (
    <>
      <Card title={t("admin:audit.filters")}>
        <div className={styles.filters}>
          <Select
            label={t("admin:audit.actor")}
            selectedKey={actorId || "any"}
            onSelectionChange={(k) => {
              setActorId(k === "any" ? "" : k);
              setOffset(0);
            }}
            options={[
              { id: "any", label: t("admin:audit.anyActor") },
              ...(users.data?.users ?? []).map((u) => ({ id: u.id, label: u.email })),
            ]}
          />
          <Select
            label={t("admin:audit.action")}
            selectedKey={action || "any"}
            onSelectionChange={(k) => {
              setAction(k === "any" ? "" : k);
              setOffset(0);
            }}
            options={[
              { id: "any", label: t("admin:audit.anyAction") },
              ...AUDIT_ACTIONS.map((a) => ({ id: a, label: t(`admin:actions.${a}`) })),
            ]}
          />
          <TextField
            label={t("admin:audit.from")}
            inputType="date"
            value={from}
            onChange={(v) => {
              setFrom(v);
              setOffset(0);
            }}
          />
          <TextField
            label={t("admin:audit.to")}
            inputType="date"
            value={to}
            onChange={(v) => {
              setTo(v);
              setOffset(0);
            }}
          />
        </div>
        <a href={contractUrl(adminAuditLogCsv, { query: filter })} download className={styles.csvLink}>
          {t("admin:audit.exportCsv")}
        </a>
      </Card>
      <ErrorMessage error={query.error} />
      {query.data ? (
        <>
          <p>
            {t("admin:audit.showing", {
              from: query.data.total === 0 ? 0 : offset + 1,
              to: offset + query.data.entries.length,
              total: formatNumber(query.data.total),
            })}
          </p>
          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.caption}>{t("admin:audit.caption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("admin:audit.colAt")}</th>
                  <th scope="col">{t("admin:audit.colActor")}</th>
                  <th scope="col">{t("admin:audit.colAction")}</th>
                  <th scope="col">{t("admin:audit.colTarget")}</th>
                  <th scope="col">{t("admin:audit.colChange")}</th>
                  <th scope="col">{t("admin:audit.colOrigin")}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.at)}</td>
                    <td>{e.actorEmail ?? t("admin:audit.system")}</td>
                    <td>{t(`admin:actions.${e.action}`)}</td>
                    <td>
                      {t(`admin:targets.${AUDIT_TARGETS.find((x) => x === e.targetType) ?? "user"}`)}
                      {e.targetId ? <div className={styles.muted}>{e.targetId}</div> : null}
                    </td>
                    <td>
                      <code className={styles.change}>{json(e.before)}</code>
                      {" → "}
                      <code className={styles.change}>{json(e.after)}</code>
                    </td>
                    <td className={styles.muted}>
                      {e.ip}
                      {e.userAgent ? <div>{e.userAgent}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.pager}>
            <Button variant="secondary" isDisabled={offset === 0} onPress={() => setOffset(Math.max(0, offset - PAGE))}>
              {t("admin:audit.prev")}
            </Button>
            <Button
              variant="secondary"
              isDisabled={offset + PAGE >= query.data.total}
              onPress={() => setOffset(offset + PAGE)}
            >
              {t("admin:audit.next")}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}

export function AdminAuditLogPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("admin:audit.title"));
  return (
    <RequireRole minRole="admin">
      {() => (
        <>
          <h1>{t("admin:audit.title")}</h1>
          <AuditLogView />
        </>
      )}
    </RequireRole>
  );
}
