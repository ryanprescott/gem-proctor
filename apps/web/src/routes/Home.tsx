import { Link, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { atLeast, useMe } from "../auth.tsx";
import { Card } from "../ui/controls.tsx";
import { useDocumentTitle } from "../ui/live.tsx";

export function HomePage() {
  const { t } = useTranslation();
  useDocumentTitle(t("common:home.title"));
  const { data: user, isPending } = useMe();
  if (isPending) return <p>{t("common:loading")}</p>;
  if (!user) return <Navigate to="/sign-in" />;
  const isProctor = atLeast(user, "proctor");
  const isAdmin = atLeast(user, "admin");
  return (
    <>
      <h1>{t("common:home.welcome", { name: user.displayName })}</h1>
      <p>{t("common:home.role", { role: t(`common:roles.${user.role}`) })}</p>
      {isProctor ? (
        <Card title={t("common:home.proctorTitle")}>
          <p>{t("common:home.proctorBody")}</p>
          <ul>
            <li>
              <Link to="/import">{t("common:home.importLink")}</Link>
            </li>
            <li>
              <Link to="/tests">{t("common:home.testsLink")}</Link>
            </li>
          </ul>
        </Card>
      ) : (
        <Card title={t("common:home.studentTitle")}>
          <p>{t("common:home.studentBody")}</p>
        </Card>
      )}
      {isAdmin ? (
        <Card title={t("common:home.adminTitle")}>
          <ul>
            <li>
              <Link to="/admin/users">{t("common:nav.users")}</Link>
            </li>
            <li>
              <Link to="/admin/settings">{t("common:nav.settings")}</Link>
            </li>
            <li>
              <Link to="/admin/audit-log">{t("common:nav.auditLog")}</Link>
            </li>
          </ul>
        </Card>
      ) : null}
    </>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  useDocumentTitle(t("common:notFound.title"));
  return (
    <>
      <h1>{t("common:notFound.title")}</h1>
      <p>{t("common:notFound.body")}</p>
      <Link to="/">{t("common:notFound.home")}</Link>
    </>
  );
}
