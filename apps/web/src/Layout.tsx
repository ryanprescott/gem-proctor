import { logout } from "@gem/shared/contracts";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "./api/client.ts";
import { atLeast, useMe, useSetMe } from "./auth.tsx";
import styles from "./Layout.module.css";
import { Button } from "./ui/controls.tsx";
import { useLive } from "./ui/live.tsx";

export function Layout() {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const setMe = useSetMe();
  const navigate = useNavigate();
  const { announce } = useLive();
  const isProctor = atLeast(user, "proctor");
  const isAdmin = atLeast(user, "admin");

  async function signOut() {
    await api.call(logout).catch(() => undefined);
    setMe(null);
    announce(t("auth:signedOut"));
    await navigate({ to: "/sign-in" });
  }

  return (
    <div className={styles.app}>
      <a className={styles.skip} href="#main">
        {t("common:skipToContent")}
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          gem-proctor
        </Link>
        <nav aria-label={t("common:nav.label")} className={styles.nav}>
          <ul>
            {user ? (
              <li>
                <Link to="/" activeOptions={{ exact: true }} activeProps={{ "aria-current": "page" }}>
                  {t("common:nav.home")}
                </Link>
              </li>
            ) : null}
            {isProctor ? (
              <>
                <li>
                  <Link to="/tests" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.tests")}
                  </Link>
                </li>
                <li>
                  <Link to="/sources" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.sources")}
                  </Link>
                </li>
                <li>
                  <Link to="/authoring" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.authoring")}
                  </Link>
                </li>
                <li>
                  <Link to="/import" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.import")}
                  </Link>
                </li>
              </>
            ) : null}
            {isAdmin ? (
              <>
                <li>
                  <Link to="/admin/users" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.users")}
                  </Link>
                </li>
                <li>
                  <Link to="/admin/settings" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.settings")}
                  </Link>
                </li>
                <li>
                  <Link to="/admin/llm" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.llm")}
                  </Link>
                </li>
                <li>
                  <Link to="/admin/audit-log" activeProps={{ "aria-current": "page" }}>
                    {t("common:nav.auditLog")}
                  </Link>
                </li>
              </>
            ) : null}
          </ul>
        </nav>
        <div className={styles.account}>
          {user ? (
            <>
              <span>{t("common:signedInAs", { name: user.displayName, role: t(`common:roles.${user.role}`) })}</span>
              <Button variant="secondary" onPress={signOut}>
                {t("auth:signOut")}
              </Button>
            </>
          ) : (
            <Link to="/sign-in">{t("auth:signIn.title")}</Link>
          )}
        </div>
      </header>
      <main id="main" className={styles.main} tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
