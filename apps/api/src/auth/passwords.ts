import { AppError, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "@gem/shared";

/**
 * Password hashing (SPEC §5.3, P0.md §5): bcrypt, cost 12, via `Bun.password`. This module is the only
 * Bun-specific code in the API; a Node fallback swaps it for `bcryptjs`.
 */
export const BCRYPT_COST = 12;

/** Rejects inputs longer than bcrypt's 72-byte limit instead of silently truncating them. */
export function checkPassword(password: string): void {
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) {
    throw new AppError("auth_password_too_long", { maxBytes: PASSWORD_MAX_BYTES });
  }
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    throw new AppError("auth_password_too_short", { minLength: PASSWORD_MIN_LENGTH });
  }
}

export async function hashPassword(password: string): Promise<string> {
  checkPassword(password);
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: BCRYPT_COST });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return false;
  return Bun.password.verify(password, hash, "bcrypt");
}

/** A valid hash of a random value, verified against when the email is unknown (uniform timing). */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= Bun.password.hash(crypto.randomUUID(), { algorithm: "bcrypt", cost: BCRYPT_COST });
  return dummyHash;
}
