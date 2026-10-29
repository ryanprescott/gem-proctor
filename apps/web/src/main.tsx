import "./styles/global.css";
import "./i18n/index.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import i18n from "./i18n/index.ts";
import { router } from "./router.tsx";
import { LiveProvider } from "./ui/live.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <LiveProvider>
            <RouterProvider router={router} />
          </LiveProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}
