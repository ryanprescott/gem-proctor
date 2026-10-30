import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Environment config, validated at startup (P0.md §5 "Config"). Missing or malformed keys fail fast
 * with the key name, never the value. Keys in the `.env` file that this schema doesn't know also fail.
 */

const base64Bytes = (min: number, max = Number.POSITIVE_INFINITY) =>
  z.string().refine(
    (s) => {
      if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return false;
      const length = Buffer.from(s, "base64").length;
      return length >= min && length <= max;
    },
    {
      message:
        min === max ? `must be exactly ${min} random bytes, base64` : `must be at least ${min} random bytes, base64`,
    },
  );

const optionalText = z
  .string()
  .optional()
  .transform((s) => (s === undefined || s.trim() === "" ? undefined : s.trim()));

const optionalInt = z
  .string()
  .optional()
  .refine((s) => s === undefined || s.trim() === "" || /^\d+$/.test(s.trim()), { message: "must be an integer" })
  .transform((s) => (s === undefined || s.trim() === "" ? undefined : Number(s)));

const optionalUrl = z
  .string()
  .optional()
  .refine((s) => s === undefined || s.trim() === "" || URL.canParse(s.trim()), { message: "must be a URL" })
  .transform((s) => (s === undefined || s.trim() === "" ? undefined : s.trim()));

const port = z.coerce.number().int().min(1).max(65535);

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    API_HOST: z.string().default("0.0.0.0"),
    /** Trust X-Forwarded-* (only behind a reverse proxy you run; otherwise clients could spoof their IP). */
    TRUST_PROXY: z.enum(["true", "false"]).default("false"),
    API_PORT: port.default(3000),
    WEB_PORT: port.default(5173),

    // Postgres. The API itself only needs the two URLs; the passwords are for Compose's init script.
    POSTGRES_DB: optionalText,
    POSTGRES_PASSWORD: optionalText,
    POSTGRES_PORT: optionalInt,
    GEM_OWNER_PASSWORD: optionalText,
    GEM_APP_PASSWORD: optionalText,
    DATABASE_URL_OWNER: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    MIGRATE_ON_START: z.enum(["true", "false"]).default("true"),

    // Auth (SPEC §5.3)
    SESSION_SECRET: base64Bytes(32),
    ADMIN_EMAIL: optionalText.pipe(z.email().optional()),
    ADMIN_PASSWORD: optionalText,
    AUTH_RATE_LIMIT_MAX: optionalInt,
    AUTH_RATE_LIMIT_WINDOW_MS: optionalInt,

    // Secrets at rest: AES-256 key for endpoint API keys (SPEC §3B.2).
    ENDPOINT_SECRET_KEY: optionalText.pipe(base64Bytes(32, 32).optional()),

    // Verify worker (SPEC §3A.3.1)
    VERIFY_SOCKET: z.string().default("/run/verify/verify.sock"),

    // Built web app served by the API in production (P0.md S2).
    WEB_DIST: optionalText,

    // Dev LLM endpoint seed: checked for shape only in P0 (used by a seed script in P1.5).
    LLM_DEV_LABEL: optionalText,
    LLM_DEV_PROVIDER: optionalText,
    LLM_DEV_SERVER: optionalText.pipe(
      z.enum(["ollama", "vllm", "llama.cpp", "llamacpp", "lmstudio", "gateway", "other"]).optional(),
    ),
    LLM_DEV_BASE_URL: optionalUrl,
    LLM_DEV_API_KEY: optionalText,
    LLM_DEV_MODEL: optionalText,
    LLM_DEV_CONTEXT: optionalInt,
    LLM_DEV_STRUCTURED_MODE: optionalText.pipe(z.enum(["native_schema", "prompt_only"]).optional()),
    LLM_DEV_CONCURRENCY: optionalInt,
    LLM_DEV_TIMEOUT_MS: optionalInt,
    LLM_DEV_ROLES: optionalText.pipe(
      z
        .string()
        .regex(/^[a-z.]+(,[a-z.]+)*$/, { message: "must be a comma-separated list of roles" })
        .optional(),
    ),
    LLM_DEV_EMBED_BASE_URL: optionalUrl,
    LLM_DEV_EMBED_MODEL: optionalText,
    LLM_DEV_EMBED_DIM: optionalInt,
    LLM_DEV_EMBED_MAX_INPUT_TOKENS: optionalInt,
    LLM_DEV_EMBED_QUERY_PREFIX: z.string().optional(),
    LLM_DEV_EMBED_DOCUMENT_PREFIX: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.ADMIN_EMAIL === undefined) !== (c.ADMIN_PASSWORD === undefined)) {
      ctx.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message: "ADMIN_EMAIL and ADMIN_PASSWORD go together" });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;
export const CONFIG_KEYS = Object.keys(ConfigSchema.shape);

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

/** Keys defined in a dotenv file (values are never returned). */
export function dotenvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

export function loadConfig(env: Record<string, string | undefined>, envFile?: string): Config {
  const problems: string[] = [];
  if (envFile && existsSync(envFile)) {
    for (const key of dotenvKeys(readFileSync(envFile, "utf8"))) {
      if (!CONFIG_KEYS.includes(key)) problems.push(`${key}: unknown key in ${envFile}`);
    }
  }
  const picked: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) picked[key] = env[key];
  const parsed = ConfigSchema.safeParse(picked);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      // Only the key and the rule: never the value.
      const key = String(issue.path[0] ?? "?");
      const what = picked[key] === undefined || picked[key] === "" ? "missing" : "invalid";
      problems.push(
        `${key}: ${what}${issue.code === "custom" || what === "invalid" ? ` (${issue.message.replace(/".*?"/g, "…")})` : ""}`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return parsed.data as Config;
}
