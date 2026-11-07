import { logout } from "@gem/shared/contracts";
import { Link, Outlet, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { RouterProvider } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { api } from "./api/client.ts";
import { atLeast, useMe, useSetMe } from "./auth.tsx";
import styles from "./Layout.module.css";
import { useLive } from "./ui/live.tsx";
import { Menu, MenuItem, MenuNote, MenuSeparator } from "./ui/Menu.tsx";

/** A group of places in the header: one button, its pages in a menu. */
interface NavGroup {
  label: string;
  /** Pages, as [path, label]; the group is current when the location is under any of them. */
  pages: [string, string][];
}

/**
 * The frame of every page: a slim header with Home and three menus (Tests, Create, Admin) instead of a link per page,
 * and the account (who's signed in, sign out) in its own menu. A group's button is marked when you're on one of its
 * pages, and the page itself is marked inside the menu. React Aria's links go through the router.
 */
export function Layout() {
  const { t } = useTranslation();
  const { data: user } = useMe();
  const setMe = useSetMe();
  const navigate = useNavigate();
  const router = useRouter();
  const { pathname } = useLocation();
  const { announce } = useLive();
  const isProctor = atLeast(user, "proctor");
  const isAdmin = atLeast(user, "admin");

  async function signOut() {
    await api.call(logout).catch(() => undefined);
    setMe(null);
    announce(t("auth:signedOut"));
    await navigate({ to: "/sign-in" });
  }

  const here = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const groups: NavGroup[] = [
    ...(isProctor
      ? [
          {
            label: t("common:nav.tests"),
            pages: [
              ["/tests", t("common:nav.allTests")],
              ["/import", t("common:nav.import")],
            ] as [string, string][],
          },
          {
            label: t("common:nav.create"),
            pages: [
              ["/sources", t("common:nav.sources")],
              ["/authoring", t("common:nav.authoring")],
            ] as [string, string][],
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            label: t("common:nav.admin"),
            pages: [
              ["/admin/users", t("common:nav.users")],
              ["/admin/settings", t("common:nav.settings")],
              ["/admin/llm", t("common:nav.llm")],
              ["/admin/audit-log", t("common:nav.auditLog")],
            ] as [string, string][],
          },
        ]
      : []),
  ];

  return (
    <RouterProvider navigate={(to) => router.navigate({ to })} useHref={(to) => router.buildLocation({ to }).href}>
      <div className={styles.app}>
        <a className={styles.skip} href="#main">
          {t("common:skipToContent")}
        </a>
        <header className={styles.header}>
          <div className={styles.bar}>
            <Link to="/" className={styles.brand}>
              <span className={styles.mark} aria-hidden="true" />
              gem-proctor
            </Link>
            <nav aria-label={t("common:nav.label")} className={styles.nav}>
              <ul>
                {user ? (
                  <li>
                    <Link
                      to="/"
                      activeOptions={{ exact: true }}
                      activeProps={{ "aria-current": "page" }}
                      className={styles.navLink}
                    >
                      {t("common:nav.home")}
                    </Link>
                  </li>
                ) : null}
                {groups.map((g) => {
                  const current = g.pages.some(([path]) => here(path));
                  return (
                    <li key={g.label}>
                      <Menu
                        label={g.label}
                        variant="nav"
                        placement="bottom start"
                        current={current}
                        items={g.pages.map(([path, label]) => (
                          <MenuItem key={path} href={path} aria-current={here(path) ? "page" : undefined}>
                            {label}
                          </MenuItem>
                        ))}
                      >
                        {g.label}
                      </Menu>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <div className={styles.account}>
              {user ? (
                <Menu
                  label={t("common:account.menu", { name: user.displayName })}
                  variant="ghost"
                  items={
                    <>
                      <MenuNote>
                        {t("common:signedInAs", { name: user.displayName, role: t(`common:roles.${user.role}`) })}
                      </MenuNote>
                      <MenuSeparator />
                      <MenuItem onAction={() => void signOut()}>{t("auth:signOut")}</MenuItem>
                    </>
                  }
                >
                  <span className={styles.avatar} aria-hidden="true">
                    {user.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={styles.accountName}>{user.displayName}</span>
                </Menu>
              ) : (
                <Link to="/sign-in" className={styles.navLink}>
                  {t("auth:signIn.title")}
                </Link>
              )}
            </div>
          </div>
        </header>
        <main id="main" className={styles.main} tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </RouterProvider>
  );
}
