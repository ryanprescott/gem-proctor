import { createHash, randomBytes } from "node:crypto";
import { type Db, User, UserSession } from "@gem/db";
import { and, eq, gt, isNull } from "drizzle-orm";

/** 14-day sliding expiry; cache TTL 60 s (P0.md §5). */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_CACHE_TTL_MS = 60 * 1000;
export const SESSION_COOKIE = "gem_session";

export interface SessionUser {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
}

interface CacheEntry {
  value: SessionUser;
  expiresAt: number;
  cachedAt: number;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Postgres-backed sessions with an in-memory cache in front (SPEC §5.3). A single API instance is
 * assumed for the cache. Logout, role changes, password resets and disabling clear cached entries in
 * the same request.
 */
export class SessionStore {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Creates a session and returns the cookie token (only its hash is stored). */
  async create(userId: string, userAgent: string | undefined): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date(this.now());
    await this.db.insert(UserSession).values({
      id: hashToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: userAgent?.slice(0, 500) ?? null,
    });
    return token;
  }

  async resolve(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;
    const id = hashToken(token);
    const now = this.now();
    const cached = this.cache.get(id);
    if (cached && now - cached.cachedAt < SESSION_CACHE_TTL_MS && cached.expiresAt > now) return cached.value;

    const rows = await this.db
      .select({
        sessionId: UserSession.id,
        userId: User.id,
        email: User.email,
        displayName: User.displayName,
      })
      .from(UserSession)
      .innerJoin(User, eq(User.id, UserSession.userId))
      .where(and(eq(UserSession.id, id), gt(UserSession.expiresAt, new Date(now)), isNull(User.disabledAt)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      this.cache.delete(id);
      return null;
    }
    // Sliding expiry, written at most once per cache period.
    const expiresAt = now + SESSION_TTL_MS;
    await this.db
      .update(UserSession)
      .set({ lastSeenAt: new Date(now), expiresAt: new Date(expiresAt) })
      .where(eq(UserSession.id, id));
    this.cache.set(id, { value: row, expiresAt, cachedAt: now });
    return row;
  }

  async destroy(token: string): Promise<void> {
    const id = hashToken(token);
    this.cache.delete(id);
    await this.db.delete(UserSession).where(eq(UserSession.id, id));
  }

  /** Drop cached entries for a user (role change): the next request re-reads the session. */
  invalidateUser(userId: string): void {
    for (const [id, entry] of this.cache) if (entry.value.userId === userId) this.cache.delete(id);
  }

  /** End every session of a user (password reset, disable). */
  async destroyAllForUser(userId: string): Promise<void> {
    this.invalidateUser(userId);
    await this.db.delete(UserSession).where(eq(UserSession.userId, userId));
  }

  cacheSize(): number {
    return this.cache.size;
  }
}
