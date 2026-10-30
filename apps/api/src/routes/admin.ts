import { AuditLog, User } from "@gem/db";
import { AppError } from "@gem/shared";
import {
  type AdminUser,
  type AuditEntry,
  type AuditQuery,
  adminAuditLog,
  adminAuditLogCsv,
  adminDisableUser,
  adminGetSettings,
  adminPutSettings,
  adminResetPassword,
  adminSetRoles,
  adminUsers,
  ROLES,
} from "@gem/shared/contracts";
import { and, asc, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { writeAudit } from "../audit.ts";
import { hashPassword } from "../auth/passwords.ts";
import type { AppContext } from "../context.ts";
import { route } from "../http/route.ts";
import { getSettings, putSettings } from "../settings.ts";
import { requestMeta } from "./auth.ts";
import { assertNoCloudRoles } from "./llm.ts";

type UserRow = typeof User.$inferSelect;

async function toAdminUser(ctx: AppContext, u: UserRow): Promise<AdminUser> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: await ctx.authz.roleOf(u.id),
    createdAt: u.createdAt.toISOString(),
    disabledAt: u.disabledAt?.toISOString() ?? null,
    lockedUntil: u.lockedUntil?.toISOString() ?? null,
    failedLoginCount: u.failedLoginCount,
  };
}

async function loadUser(ctx: AppContext, id: string): Promise<UserRow> {
  const rows = await ctx.db.select().from(User).where(eq(User.id, id)).limit(1);
  const u = rows[0];
  if (!u) throw new AppError("user_not_found");
  return u;
}

async function activeAdminCount(ctx: AppContext): Promise<number> {
  const users = await ctx.db.select({ id: User.id, disabledAt: User.disabledAt }).from(User);
  let n = 0;
  for (const u of users) if (!u.disabledAt && (await ctx.authz.roleOf(u.id)) === "admin") n++;
  return n;
}

function auditFilter(q: Omit<AuditQuery, "limit" | "offset">): SQL | undefined {
  const conds: SQL[] = [];
  if (q.actorId) conds.push(eq(AuditLog.actorId, q.actorId));
  if (q.action) conds.push(eq(AuditLog.action, q.action));
  if (q.from) conds.push(gte(AuditLog.at, new Date(q.from)));
  if (q.to) conds.push(lte(AuditLog.at, new Date(q.to)));
  return conds.length > 0 ? and(...conds) : undefined;
}

async function auditEntries(ctx: AppContext, where: SQL | undefined, limit?: number, offset?: number) {
  const base = ctx.db
    .select({
      id: AuditLog.id,
      at: AuditLog.at,
      actorId: AuditLog.actorId,
      actorEmail: User.email,
      action: AuditLog.action,
      targetType: AuditLog.targetType,
      targetId: AuditLog.targetId,
      before: AuditLog.before,
      after: AuditLog.after,
      ip: AuditLog.ip,
      userAgent: AuditLog.userAgent,
    })
    .from(AuditLog)
    .leftJoin(User, eq(User.id, AuditLog.actorId))
    .where(where)
    .orderBy(desc(AuditLog.at), desc(AuditLog.id));
  const rows = limit === undefined ? await base : await base.limit(limit).offset(offset ?? 0);
  return rows.map(
    (r): AuditEntry => ({
      ...r,
      at: r.at.toISOString(),
      actorEmail: r.actorEmail ?? null,
      action: r.action as AuditEntry["action"],
    }),
  );
}

/**
 * RFC 4180: CRLF line ends; fields with comma, quote, CR or LF are quoted, quotes doubled. Text that a
 * spreadsheet would run as a formula (user agents and emails are user-controlled) gets a leading `'`.
 */
export function csvField(v: unknown): string {
  let s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: unknown[][]): string {
  return `${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  route(app, adminUsers, async () => {
    const rows = await ctx.db.select().from(User).orderBy(asc(User.createdAt));
    return { users: await Promise.all(rows.map((u) => toAdminUser(ctx, u))) };
  });

  route(app, adminSetRoles, async ({ params, body, user, request }) => {
    const target = await loadUser(ctx, params.id);
    const before = await ctx.authz.roleOf(target.id);
    if (before === body.role) return { user: await toAdminUser(ctx, target) };
    if (before === "admin" && !target.disabledAt && (await activeAdminCount(ctx)) <= 1) {
      throw new AppError("admin_last_admin");
    }
    await ctx.authz.setRole(target.id, body.role);
    // The decision cache is cleared by setRole; cached sessions are re-read on the next request.
    ctx.sessions.invalidateUser(target.id);
    const promote = ROLES.indexOf(body.role) > ROLES.indexOf(before);
    await writeAudit(ctx.db, {
      actorId: user.userId,
      action: promote ? "role.grant" : "role.revoke",
      targetType: "user",
      targetId: target.id,
      before: { role: before },
      after: { role: body.role },
      ...requestMeta(request),
    });
    return { user: await toAdminUser(ctx, target) };
  });

  route(app, adminResetPassword, async ({ params, body, user, request }) => {
    const target = await loadUser(ctx, params.id);
    const passwordHash = await hashPassword(body.password);
    await ctx.db.transaction(async (tx) => {
      await tx.update(User).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(User.id, target.id));
      await writeAudit(tx, {
        actorId: user.userId,
        action: "user.password_reset",
        targetType: "user",
        targetId: target.id,
        // The fact of the change only; the password never appears.
        before: { lockedUntil: target.lockedUntil?.toISOString() ?? null, failedLoginCount: target.failedLoginCount },
        after: { lockedUntil: null, failedLoginCount: 0 },
        ...requestMeta(request),
      });
    });
    if (target.id !== user.userId) await ctx.sessions.destroyAllForUser(target.id);
    return { user: await toAdminUser(ctx, await loadUser(ctx, target.id)) };
  });

  route(app, adminDisableUser, async ({ params, body, user, request }) => {
    const target = await loadUser(ctx, params.id);
    const wasDisabled = target.disabledAt !== null;
    if (wasDisabled === body.disabled) return { user: await toAdminUser(ctx, target) };
    if (body.disabled && (await ctx.authz.roleOf(target.id)) === "admin" && (await activeAdminCount(ctx)) <= 1) {
      throw new AppError("admin_last_admin");
    }
    const disabledAt = body.disabled ? ctx.now() : null;
    await ctx.db.transaction(async (tx) => {
      await tx.update(User).set({ disabledAt }).where(eq(User.id, target.id));
      await writeAudit(tx, {
        actorId: user.userId,
        action: body.disabled ? "user.disable" : "user.enable",
        targetType: "user",
        targetId: target.id,
        before: { disabledAt: target.disabledAt?.toISOString() ?? null },
        after: { disabledAt: disabledAt?.toISOString() ?? null },
        ...requestMeta(request),
      });
    });
    if (body.disabled) await ctx.sessions.destroyAllForUser(target.id);
    return { user: await toAdminUser(ctx, await loadUser(ctx, target.id)) };
  });

  route(app, adminGetSettings, async () => ({ settings: await getSettings(ctx.db) }));

  route(app, adminPutSettings, async ({ body, user, request }) => {
    if (body.localEndpointsOnly) await assertNoCloudRoles(ctx);
    const before = await getSettings(ctx.db);
    await ctx.db.transaction(async (tx) => {
      await putSettings(tx, body, user.userId);
      await writeAudit(tx, {
        actorId: user.userId,
        action: "settings.update",
        targetType: "settings",
        targetId: null,
        before,
        after: { ...before, ...body },
        ...requestMeta(request),
      });
    });
    return { settings: await getSettings(ctx.db) };
  });

  route(app, adminAuditLog, async ({ query }) => {
    const where = auditFilter(query);
    const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(AuditLog).where(where);
    return { entries: await auditEntries(ctx, where, query.limit, query.offset), total };
  });

  route(app, adminAuditLogCsv, async ({ query, reply }) => {
    const entries = await auditEntries(ctx, auditFilter(query));
    const header = [
      "id",
      "at",
      "actor_id",
      "actor_email",
      "action",
      "target_type",
      "target_id",
      "before",
      "after",
      "ip",
      "user_agent",
    ];
    const rows = entries.map((e) => [
      e.id,
      e.at,
      e.actorId,
      e.actorEmail,
      e.action,
      e.targetType,
      e.targetId,
      e.before,
      e.after,
      e.ip,
      e.userAgent,
    ]);
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="audit-log.csv"');
    return toCsv([header, ...rows]);
  });
}
