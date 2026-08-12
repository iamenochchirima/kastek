import { createHash, randomBytes } from "node:crypto";

export interface PairingToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createPairingToken(ttlSeconds = 600, now = new Date()): PairingToken {
  const token = `kasiai_pair_${randomBytes(24).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + Math.max(60, Math.min(ttlSeconds, 86_400)) * 1000);
  return { token, tokenHash: hashPairingToken(token), expiresAt };
}

export function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isPairingTokenExpired(expiresAt: Date | string, now = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}
