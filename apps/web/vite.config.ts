import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiPort = process.env.API_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  // One bundle in P0; code splitting comes with the larger P1+ pages.
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1600 },
});
