import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AuditLog } from "@gem/db";
import pg from "pg";
import { csvField, toCsv } from "../src/routes/admin.ts";
import { API, type Client, createTestApp, hasDb, registerUser, signIn, type TestApp } from "./helpers.ts";

/** Minimal RFC 4180 parser for the test (quoted fields, doubled quotes, CRLF). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else field += c;
    i++;
  }
  return rows;
}

describe.skipIf(!hasDb)("audit log", () => {
  let t: TestApp;
  let admin: Client;
  let adminId = "";
  let userId = "";
  const UA = "audit-test-agent/1.0";

  beforeAll(async () => {
    t = await createTestApp();
    const a = await registerUser(t.app, "admin@example.com");
    admin = a.client;
    adminId = a.user.id;
    userId = (await registerUser(t.app, "user@example.com")).user.id;
  });
  afterAll(async () => t?.close());

  const call = (method: "PUT" | "POST", url: string, payload: unknown) =>
    admin.request({
      method,
      url: `${API}${url}`,
      payload: payload as never,
      headers: { "user-agent": UA },
      remoteAddress: "203.0.113.7",
    });

  test("A20: each admin action writes one row with actor, action, target, before/after, IP, UA; no passwords", async () => {
    const actions: [string, () => Promise<unknown>, unknown, unknown][] = [
      [
        "role.grant",
        () => call("PUT", `/admin/users/${userId}/roles`, { role: "proctor" }),
        { role: "student" },
        { role: "proctor" },
      ],
      [
        "role.revoke",
        () => call("PUT", `/admin/users/${userId}/roles`, { role: "student" }),
        { role: "proctor" },
        { role: "student" },
      ],
      [
        "user.password_reset",
        () => call("POST", `/admin/users/${userId}/reset-password`, { password: "s3cret-new-pass" }),
        expect.anything(),
        expect.anything(),
      ],
      [
        "user.disable",
        () => call("POST", `/admin/users/${userId}/disable`, { disabled: true }),
        { disabledAt: null },
        expect.anything(),
      ],
      [
        "user.enable",
        () => call("POST", `/admin/users/${userId}/disable`, { disabled: false }),
        expect.anything(),
        { disabledAt: null },
      ],
      [
        "settings.update",
        () => call("PUT", "/admin/settings", { selfRegistration: false }),
        { selfRegistration: true },
        { selfRegistration: false },
      ],
    ];
    for (const [action, run, before, after] of actions) {
      const n0 = (await t.db.select().from(AuditLog)).length;
      const res = (await run()) as { statusCode: number };
      expect(res.statusCode).toBe(200);
      const rows = await t.db.select().from(AuditLog);
      expect(rows.length).toBe(n0 + 1);
      const row = rows.filter((r) => r.action === action).at(-1);
      expect(row).toMatchObject({
        actorId: adminId,
        action,
        targetType: action === "settings.update" ? "settings" : "user",
        targetId: action === "settings.update" ? null : userId,
        before,
        after,
        ip: "203.0.113.7",
        userAgent: UA,
      });
    }
    const everything = JSON.stringify(await t.db.select().from(AuditLog));
    expect(everything).not.toContain("s3cret-new-pass");
    expect(everything).not.toContain("correct horse");
    // Bootstrap user creation (first registration) is logged too.
    const created = await t.db.select().from(AuditLog);
    expect(created.filter((r) => r.action === "user.create")).toHaveLength(1);
    await call("PUT", "/admin/settings", { selfRegistration: true });
  });

  test("A21: as gem_app, UPDATE and DELETE on audit_log fail with permission denied", async () => {
    const client = new pg.Client({ connectionString: t.database.appUrl });
    await client.connect();
    try {
      const who = await client.query("SELECT current_user AS u");
      expect(who.rows[0].u).toBe("gem_app");
      expect((await client.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBeGreaterThan(0);
      await expect(client.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow(/permission denied/);
      await expect(client.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
      await expect(client.query("TRUNCATE audit_log")).rejects.toThrow(/permission denied/);
      // INSERT is allowed (append-only).
      await client.query(
        "INSERT INTO audit_log (id, action, target_type) VALUES ('01890000-0000-7000-8000-0000000000aa', 'settings.update', 'settings')",
      );
      // Everything else stays writable for the app.
      await client.query("UPDATE instance_settings SET updated_at = now()");
    } finally {
      await client.end();
    }
  });

  test("A22: filter by actor, action and date range", async () => {
    const all = (await admin.get(`${API}/admin/audit-log`)).json();
    expect(all.total).toBeGreaterThanOrEqual(8);
    const byAction = (await admin.get(`${API}/admin/audit-log?action=role.grant`)).json();
    expect(byAction.entries.map((e: { action: string }) => e.action)).toEqual(["role.grant"]);
    const byActor = (await admin.get(`${API}/admin/audit-log?actorId=${adminId}`)).json();
    expect(byActor.entries.every((e: { actorId: string }) => e.actorId === adminId)).toBe(true);
    expect(byActor.entries[0].actorEmail).toBe("admin@example.com");
    const future = new Date(Date.now() + 3600_000).toISOString();
    const none = (await admin.get(`${API}/admin/audit-log?from=${encodeURIComponent(future)}`)).json();
    expect(none.total).toBe(0);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const ranged = (
      await admin.get(`${API}/admin/audit-log?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`)
    ).json();
    expect(ranged.total).toBe(all.total);
    const paged = (await admin.get(`${API}/admin/audit-log?limit=2&offset=1`)).json();
    expect(paged.entries).toHaveLength(2);
    expect(paged.entries[0].id).toBe(all.entries[1].id);
  });

  test("A22: CSV export is RFC 4180 and honours the filter", async () => {
    const res = await admin.get(`${API}/admin/audit-log.csv?action=settings.update`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual([
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
    ]);
    expect(rows.slice(1).every((r) => r[4] === "settings.update" && r.length === 11)).toBe(true);
    const withAfter = rows.slice(1).find((r) => r[8] !== "");
    expect(JSON.parse(withAfter?.[8] ?? "null")).toMatchObject({ selfRegistration: expect.any(Boolean) });
  });

  test("csv helpers quote commas, quotes and line breaks", () => {
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField(null)).toBe("");
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(
      toCsv([
        ["a", "b"],
        ["1", "2"],
      ]),
    ).toBe("a,b\r\n1,2\r\n");
    expect(parseCsv(toCsv([["x,y", 'q"q', "n\r\nl"]]))).toEqual([["x,y", 'q"q', "n\r\nl"]]);
  });

  test("audit log is admin-only", async () => {
    const { client } = await signIn(t.app, "user@example.com", "s3cret-new-pass");
    expect((await client.get(`${API}/admin/audit-log`)).statusCode).toBe(403);
  });
});
