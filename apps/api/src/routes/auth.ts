import { newId, User } from "@gem/db";
import { AppError } from "@gem/shared";
import { login, logout, type Me, me, type Role, register } from "@gem/shared/contracts";
import { count, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { writeAudit } from "../audit.ts";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../auth/passwords.ts";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../auth/sessions.ts";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";
import { getSettings } from "../settings.ts";

/** 10 failed logins → locked for 15 minutes; an admin password reset clears it (P0.md §5). */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Serializes first-account bootstrap across concurrent registrations. */
const BOOTSTRAP_LOCK = 0x67656d01;

export function cookieOptions(ctx: AppContext) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Secure may be off only in development (P0.md A13).
    secure: ctx.config.NODE_ENV !== "development",
    path: "/",
    signed: true,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export function requestMeta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] ?? null };
}

async function startSession(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = await ctx.sessions.create(userId, request.headers["user-agent"]);
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(ctx));
}

function toMe(u: { id: string; email: string; displayName: string }, role: Role): Me {
  return { id: u.id, email: u.email, displayName: u.displayName, role };
}

/**
 * First-admin bootstrap from env (SPEC §5.1, P0.md S7). Creates the env admin once; does nothing if an
 * account with that email exists.
 */
export async function bootstrapEnvAdmin(ctx: AppContext): Promise<void> {
  const email = ctx.config.ADMIN_EMAIL;
  const password = ctx.config.ADMIN_PASSWORD;
  if (!email || !password) return;
  const passwordHash = await hashPassword(password);
  const createdId = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
    const existing = await tx
      .select({ id: User.id })
      .from(User)
      .where(sql`lower(${User.email}) = lower(${email})`)
      .limit(1);
    if (existing.length > 0) return null;
    const id = newId();
    await tx
      .insert(User)
      .values({ id, email: email.toLowerCase(), passwordHash, displayName: email.split("@")[0] ?? email });
    await writeAudit(tx, {
      actorId: null,
      action: "user.create",
      targetType: "user",
      targetId: id,
      after: { email: email.toLowerCase(), role: "admin", via: "env_bootstrap" },
    });
    return id;
  });
  // The grant goes through Casbin (and its adapter) once the user row is committed.
  if (createdId) await ctx.authz.setRole(createdId, "admin");
}

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS } = ctx.config;
  const rateLimit = { max: AUTH_RATE_LIMIT_MAX ?? 20, timeWindow: AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000 };

  route(
    app,
    register,
    async ({ body, request, reply }) => {
      const settings = await getSettings(ctx.db);
      if (!settings.selfRegistration) throw new AppError("auth_registration_disabled");
      const passwordHash = await hashPassword(body.password);
      const email = body.email.toLowerCase();

      const created = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);
        const taken = await tx.select({ id: User.id }).from(User).where(sql`lower(${User.email}) = ${email}`).limit(1);
        if (taken.length > 0) throw new AppError("auth_email_taken");
        const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(User);
        // Without an env admin, the first account created is made admin (SPEC §5.1).
        const role: Role = n === 0 ? "admin" : "student";
        const id = newId();
        await tx.insert(User).values({ id, email, passwordHash, displayName: body.displayName });
        if (role === "admin") {
          await writeAudit(tx, {
            actorId: id,
            action: "user.create",
            targetType: "user",
            targetId: id,
            after: { email, role, via: "first_registration" },
            ...requestMeta(request),
          });
        }
        return { id, email, displayName: body.displayName, role };
      });
      await ctx.authz.setRole(created.id, created.role);
      await startSession(ctx, request, reply, created.id);
      return { user: toMe(created, created.role) };
    },
    { rateLimit },
  );

  route(
    app,
    login,
    async ({ body, request, reply }) => {
      const email = body.email.trim().toLowerCase();
      const rows = await ctx.db.select().from(User).where(sql`lower(${User.email}) = ${email}`).limit(1);
      const user = rows[0];
      if (!user) {
        await verifyPassword(body.password, await dummyPasswordHash());
        throw new AppError("auth_invalid_credentials");
      }
      const now = ctx.now();
      if (user.lockedUntil && user.lockedUntil > now) {
        throw new AppError("auth_account_locked", { until: user.lockedUntil.toISOString() });
      }
      const ok = await verifyPassword(body.password, user.passwordHash);
      if (!ok) {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= LOCKOUT_THRESHOLD;
        await ctx.db
          .update(User)
          .set({
            failedLoginCount: lock ? 0 : failed,
            lockedUntil: lock ? new Date(now.getTime() + LOCKOUT_MS) : user.lockedUntil,
          })
          .where(eq(User.id, user.id));
        if (lock)
          throw new AppError("auth_account_locked", { until: new Date(now.getTime() + LOCKOUT_MS).toISOString() });
        throw new AppError("auth_invalid_credentials");
      }
      if (user.disabledAt) throw new AppError("auth_account_disabled");
      if (user.failedLoginCount !== 0 || user.lockedUntil) {
        await ctx.db.update(User).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(User.id, user.id));
      }
      await startSession(ctx, request, reply, user.id);
      return { user: toMe(user, await ctx.authz.roleOf(user.id)) };
    },
    { rateLimit },
  );

  route(app, logout, async ({ request, reply }) => {
    const raw = request.cookies[SESSION_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) await ctx.sessions.destroy(unsigned.value);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true as const };
  });

  route(app, me, async ({ user }) => ({
    user: { id: user.userId, email: user.email, displayName: user.displayName, role: user.role },
  }));
}
