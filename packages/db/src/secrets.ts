import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Endpoint API keys at rest (SPEC §3B.2, P1.5.md §4): AES-256-GCM, a fresh 12-byte IV per write, the
 * endpoint id as associated data, so a ciphertext copied to another row doesn't decrypt.
 * Format: `base64(iv ‖ ciphertext ‖ tag)`. The key is `ENDPOINT_SECRET_KEY`, 32 bytes in base64.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

function keyBytes(secretKey: string): Buffer {
  const key = Buffer.from(secretKey, "base64");
  if (key.length !== 32) throw new Error("ENDPOINT_SECRET_KEY must be 32 bytes, base64");
  return key;
}

export function encryptSecret(plaintext: string, secretKey: string, endpointId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(secretKey), iv);
  cipher.setAAD(Buffer.from(endpointId, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64");
}

/** Throws on a tampered ciphertext, a wrong key or a different endpoint id. */
export function decryptSecret(ciphertext: string, secretKey: string, endpointId: string): string {
  const raw = Buffer.from(ciphertext, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(secretKey), raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(endpointId, "utf8"));
  decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
  const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  return body.toString("utf8");
}
