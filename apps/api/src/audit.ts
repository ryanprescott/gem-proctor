import { AuditLog, type Db, newId } from "@gem/db";
import type { AuditAction } from "@gem/shared/contracts";

export interface AuditInput {
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

const SECRET_KEYS = /password|secret|token|apikey|api_key/i;

/** Secrets are redacted from before/after, whatever the caller passes (SPEC §1.3). */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v);
    return out;
  }
  return value;
}

/** Append one row to the audit log. The app's DB user can only INSERT/SELECT this table. */
export async function writeAudit(db: Pick<Db, "insert">, entry: AuditInput): Promise<void> {
  await db.insert(AuditLog).values({
    id: newId(),
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 500) ?? null,
  });
}
