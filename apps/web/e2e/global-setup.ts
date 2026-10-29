import { request } from "@playwright/test";
import { adminRequest } from "./helpers.ts";

/** One admin for the whole run: the first registration on a fresh database (or E2E_ADMIN_* for Compose). */
export default async function globalSetup() {
  if (process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD) return;
  const ctx = await request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const admin = await adminRequest(ctx);
  await ctx.dispose();
  process.env.E2E_ADMIN_EMAIL = admin.email;
  process.env.E2E_ADMIN_PASSWORD = admin.password;
}
