import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./Layout.tsx";
import { AdminAuditLogPage, AdminSettingsPage, AdminUsersPage } from "./routes/Admin.tsx";
import { AdminLlmPage } from "./routes/AdminLlm.tsx";
import { AttemptPage } from "./routes/Attempt.tsx";
import { HomePage, NotFoundPage } from "./routes/Home.tsx";
import { ImportPage } from "./routes/Import.tsx";
import { ResultsPage } from "./routes/Results.tsx";
import { RegisterPage, SignInPage } from "./routes/SignIn.tsx";
import { SourceDetailPage, type SourceSearch } from "./routes/SourceDetail.tsx";
import { SourcesPage } from "./routes/Sources.tsx";
import { TestDetailPage, TestsPage } from "./routes/Tests.tsx";

/** TanStack Router (P0.md §5), code-based routes for the pages in P0.md §6 and P1.md §6. */
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
  createRoute({
    getParentRoute: () => root,
    path: "/practice/attempts/$attemptId",
    component: function AttemptRoute() {
      const { attemptId } = attemptRoute.useParams();
      return <AttemptPage attemptId={attemptId} />;
    },
  }),
  createRoute({
    getParentRoute: () => root,
    path: "/practice/attempts/$attemptId/results",
    component: function ResultsRoute() {
      const { attemptId } = resultsRoute.useParams();
      return <ResultsPage attemptId={attemptId} />;
    },
  }),
  createRoute({ getParentRoute: () => root, path: "/admin/users", component: AdminUsersPage }),
  createRoute({ getParentRoute: () => root, path: "/admin/settings", component: AdminSettingsPage }),
  createRoute({ getParentRoute: () => root, path: "/admin/llm", component: AdminLlmPage }),
  createRoute({ getParentRoute: () => root, path: "/admin/audit-log", component: AdminAuditLogPage }),
  createRoute({ getParentRoute: () => root, path: "/sources", component: SourcesPage }),
  createRoute({
    getParentRoute: () => root,
    path: "/sources/$sourceId",
    validateSearch: (search: Record<string, unknown>): SourceSearch => ({
      ...(typeof search.revision === "number" ? { revision: search.revision } : {}),
      ...(typeof search.chunk === "string" ? { chunk: search.chunk } : {}),
      ...(typeof search.quote === "string" ? { quote: search.quote } : {}),
    }),
    component: function SourceRoute() {
      const { sourceId } = sourceRoute.useParams();
      const search = sourceRoute.useSearch();
      return <SourceDetailPage sourceId={sourceId} search={search} />;
    },
  }),
] as const;
const testRoute = routes[5];
const attemptRoute = routes[6];
const resultsRoute = routes[7];
const sourceRoute = routes[13];

export const router = createRouter({ routeTree: root.addChildren([...routes]), defaultPreload: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
