import { type Db, InstanceSettings as SettingsTable } from "@gem/db";
import { DEFAULT_AUTHORING_SETTINGS, DEFAULT_VERIFY_SETTINGS } from "@gem/shared";
import { InstanceSettings } from "@gem/shared/contracts";
import { sql } from "drizzle-orm";

export const DEFAULT_SETTINGS: InstanceSettings = {
  selfRegistration: true,
  localEndpointsOnly: false,
  verify: DEFAULT_VERIFY_SETTINGS,
  authoring: DEFAULT_AUTHORING_SETTINGS,
};

export async function getSettings(db: Pick<Db, "select">): Promise<InstanceSettings> {
  const rows = await db.select().from(SettingsTable);
  const stored: Record<string, unknown> = {};
  for (const r of rows) stored[r.key] = r.value;
  const parsed = InstanceSettings.partial().safeParse(stored);
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}

export async function putSettings(
  db: Pick<Db, "insert">,
  values: Partial<InstanceSettings>,
  actorId: string | null,
): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await db
      .insert(SettingsTable)
      .values({ key, value, updatedBy: actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: SettingsTable.key,
        set: { value, updatedBy: actorId, updatedAt: sql`now()` },
      });
  }
}
