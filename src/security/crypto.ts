import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";

function masterKey(): Buffer {
  const raw = config.encryptionKey || config.authSecret;
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: enc.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(row: { ciphertext: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const deriveKey = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await deriveKey(password, salt, 32) as Buffer).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
  return timingSafeEqual(await deriveKey(password, salt, 32) as Buffer, Buffer.from(hash, "hex"));
}

export function fingerprintKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function last4(key: string): string {
  const trimmed = key.trim();
  return trimmed.slice(-4);
}
