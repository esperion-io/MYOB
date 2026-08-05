import crypto from "node:crypto";
import { config } from "../config.js";

const PREFIX = "enc:v1:";

function keyMaterial(): Buffer | null {
  const secret = config.tokenEncryptionKey;
  if (!secret) return null;
  return crypto.createHash("sha256").update(secret).digest();
}

/** Encrypt token at rest when TOKEN_ENCRYPTION_KEY is set. */
export function sealToken(plain: string): string {
  const key = keyMaterial();
  if (!key) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    Buffer.concat([iv, tag, encrypted]).toString("base64url")
  );
}

export function openToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = keyMaterial();
  if (!key) {
    throw new Error(
      "Encrypted tokens found but TOKEN_ENCRYPTION_KEY is not set.",
    );
  }

  const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}
