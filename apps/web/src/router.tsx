import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./Layout.tsx";
import { AdminAuditLogPage, AdminSettingsPage, AdminUsersPage } from "./routes/Admin.tsx";
import { HomePage, NotFoundPage } from "./routes/Home.tsx";
import { ImportPage } from "./routes/Import.tsx";
import { RegisterPage, SignInPage } from "./routes/SignIn.tsx";
import { TestDetailPage, TestsPage } from "./routes/Tests.tsx";

/** TanStack Router (P0.md §5), code-based routes for the pages in P0.md §6. */
const root = createRootRoute({ component: Layout, notFoundComponent: NotFoundPage });

const routes = [
  createRoute({ getParentRoute: () => root, path: "/", component: HomePage }),
  createRoute({ getParentRoute: () => root, path: "/sign-in", component: SignInPage }),
  createRoute({ getParentRoute: () => root, path: "/register", component: RegisterPage }),
  createRoute({ getParentRoute: () => root, path: "/import", component: ImportPage }),
  createRoute({ getParentRoute: () => root, path: "/tests", component: TestsPage }),
  createRoute({
    getParentRoute: () => root,
    path: "/tests/$testId",
    component: function TestRoute() {
      const { testId } = testRoute.useParams();
      return <TestDetailPage testId={testId} />;
    },
  }),
  createRoute({ getParentRoute: () => root, path: "/admin/users", component: AdminUsersPage }),
  createRoute({ getParentRoute: () => root, path: "/admin/settings", component: AdminSettingsPage }),
  createRoute({ getParentRoute: () => root, path: "/admin/audit-log", component: AdminAuditLogPage }),
] as const;
const testRoute = routes[5];

export const router = createRouter({ routeTree: root.addChildren([...routes]), defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
