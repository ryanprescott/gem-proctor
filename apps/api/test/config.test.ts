import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, dotenvKeys, loadConfig } from "../src/config.ts";

const good = {
  DATABASE_URL: "postgres://gem_app:pw@localhost:5432/gem",
  DATABASE_URL_OWNER: "postgres://gem_owner:pw@localhost:5432/gem",
  SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
};

function problems(env: Record<string, string>, file?: string): string[] {
  try {
    loadConfig(env, file);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
}

describe("config (P0.md §5)", () => {
  test("ENDPOINT_SECRET_KEY is optional, and exactly 32 bytes when set", () => {
    expect(problems(good)).toEqual([]);
    expect(problems({ ...good, ENDPOINT_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") })).toEqual([]);
    for (const size of [16, 33]) {
      const key = Buffer.alloc(size, 1).toString("base64");
      expect(problems({ ...good, ENDPOINT_SECRET_KEY: key }).join()).toContain("ENDPOINT_SECRET_KEY: invalid");
    }
  });

  test("valid config loads with defaults", () => {
    const c = loadConfig(good);
    expect(c.NODE_ENV).toBe("production");
    expect(c.API_PORT).toBe(3000);
    expect(c.VERIFY_SOCKET).toBe("/run/verify/verify.sock");
  });

  test("missing keys fail fast with the key name", () => {
    const p = problems({ ...good, SESSION_SECRET: "" });
    expect(p).toHaveLength(1);
    expect(p[0]).toStartWith("SESSION_SECRET: missing");
  });

  test("malformed keys name the key, never the value", () => {
    const secret = "short-secret-value";
    const p = problems({ ...good, SESSION_SECRET: secret, DATABASE_URL: "mysql://u:hunter2@x/y", API_PORT: "99999" });
    expect(p.map((x) => x.split(":")[0])).toEqual(
      expect.arrayContaining(["SESSION_SECRET", "DATABASE_URL", "API_PORT"]),
    );
    const text = p.join("\n");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("hunter2");
  });

  test("LLM_DEV_* keys are checked for shape only", () => {
    expect(problems({ ...good, LLM_DEV_BASE_URL: "", LLM_DEV_EMBED_DIM: "" })).toEqual([]);
    const p = problems({
      ...good,
      LLM_DEV_EMBED_DIM: "seven",
      LLM_DEV_STRUCTURED_MODE: "magic",
      LLM_DEV_BASE_URL: "not a url",
    });
    expect(p.map((x) => x.split(":")[0]).sort()).toEqual([
      "LLM_DEV_BASE_URL",
      "LLM_DEV_EMBED_DIM",
      "LLM_DEV_STRUCTURED_MODE",
    ]);
  });

  test("ADMIN_EMAIL and ADMIN_PASSWORD go together", () => {
    expect(problems({ ...good, ADMIN_EMAIL: "a@example.com" })[0]).toStartWith("ADMIN_PASSWORD");
  });

  test("unknown keys in the .env file fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "gem-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "# comment\nNODE_ENV=development\nSESION_SECRET=typo\n");
    expect(dotenvKeys("A=1\n# B=2\nexport C=3\n")).toEqual(["A", "C"]);
    expect(problems(good, file)).toEqual([`SESION_SECRET: unknown key in ${file}`]);
  });

  test(".env.example only contains known keys", () => {
    const example = join(import.meta.dir, "..", "..", "..", ".env.example");
    expect(problems(good, example)).toEqual([]);
  });
});
