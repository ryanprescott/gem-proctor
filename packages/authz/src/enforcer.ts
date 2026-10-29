import { readFileSync } from "node:fs";
import { join } from "node:path";
import { casbinRule, type Db } from "@gem/db";
import { highestRole, ROLES, type Role } from "@gem/shared/contracts";
import { type Adapter, type CachedEnforcer, Helper, type Model, newCachedEnforcer, newModelFromString } from "casbin";
import { and, eq } from "drizzle-orm";

export const MODEL_PATH = join(import.meta.dir, "model.conf");
export const POLICY_PATH = join(import.meta.dir, "policy.csv");

export type Relationship = "owner" | "member" | "none";

function policyLines(): string[] {
  return readFileSync(POLICY_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

/**
 * Small custom adapter on Drizzle (P0.md §5, SPEC §13 Q13): `p` lines and role → role links come from
 * policy.csv; only user → role `g` lines live in the database.
 */
export class DrizzleCasbinAdapter implements Adapter {
  constructor(private readonly db: Db) {}

  async loadPolicy(model: Model): Promise<void> {
    for (const line of policyLines()) Helper.loadPolicyLine(line, model);
    const rows = await this.db.select().from(casbinRule).where(eq(casbinRule.ptype, "g"));
    for (const r of rows) Helper.loadPolicyLine(`g, ${r.v0}, ${r.v1}`, model);
  }

  async savePolicy(): Promise<boolean> {
    throw new Error("policy is read-only: p lines live in policy.csv");
  }

  async addPolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    if (ptype !== "g") throw new Error("only g lines are stored in the database");
    await this.db
      .insert(casbinRule)
      .values({ ptype, v0: rule[0] ?? null, v1: rule[1] ?? null })
      .onConflictDoNothing();
  }

  async removePolicy(_sec: string, ptype: string, rule: string[]): Promise<void> {
    if (ptype !== "g") throw new Error("only g lines are stored in the database");
    await this.db
      .delete(casbinRule)
      .where(and(eq(casbinRule.ptype, ptype), eq(casbinRule.v0, rule[0] ?? ""), eq(casbinRule.v1, rule[1] ?? "")));
  }

  async removeFilteredPolicy(_sec: string, ptype: string, fieldIndex: number, ...values: string[]): Promise<void> {
    if (ptype !== "g" || fieldIndex !== 0 || values.length === 0) {
      throw new Error("only user-filtered g removals are supported");
    }
    const conds = [eq(casbinRule.ptype, ptype), eq(casbinRule.v0, values[0] ?? "")];
    if (values[1]) conds.push(eq(casbinRule.v1, values[1]));
    await this.db.delete(casbinRule).where(and(...conds));
  }
}

/**
 * The app's authorization service: Casbin's CachedEnforcer, with the decision cache cleared on every
 * role change (SPEC §5.2).
 */
export class Authz {
  private constructor(private readonly enforcer: CachedEnforcer) {}

  static async create(db: Db): Promise<Authz> {
    const model = newModelFromString(readFileSync(MODEL_PATH, "utf8"));
    const enforcer = await newCachedEnforcer(model, new DrizzleCasbinAdapter(db));
    enforcer.setEnableCache(true);
    return new Authz(enforcer);
  }

  async can(userId: string, objType: string, act: string, rel: Relationship = "none"): Promise<boolean> {
    return this.enforcer.enforce(userId, objType, act, rel);
  }

  /** Roles granted directly to the user (not inherited). */
  async grantedRoles(userId: string): Promise<Role[]> {
    const roles = await this.enforcer.getRolesForUser(userId);
    return ROLES.filter((r) => roles.includes(r));
  }

  async roleOf(userId: string): Promise<Role> {
    return highestRole(await this.grantedRoles(userId));
  }

  /** Replace the user's grant with `role`. Persists through the adapter and clears cached decisions. */
  async setRole(userId: string, role: Role): Promise<void> {
    await this.enforcer.deleteRolesForUser(userId);
    await this.enforcer.addRoleForUser(userId, role);
    this.enforcer.invalidateCache();
  }

  /** Re-read grants from the database (e.g. after a direct DB change in tests). */
  async reload(): Promise<void> {
    await this.enforcer.loadPolicy();
    this.enforcer.invalidateCache();
  }

  /** Every (objType, act) pair the policy file mentions, for the startup check. */
  policyPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const line of policyLines()) {
      const [ptype, , obj, act] = line.split(",").map((s) => s.trim());
      if (ptype === "p" && obj && act) pairs.add(`${obj}:${act}`);
    }
    return pairs;
  }
}
