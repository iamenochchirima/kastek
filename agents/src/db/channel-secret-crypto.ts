import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

function encryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("AGENTS_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function encryptChannelSecret(secret: string, rawKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
}

export function decryptChannelSecret(payload: string, rawKey: string): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = payload.split(".");
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Invalid encrypted channel credential payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(rawKey), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
}

export function hashChannelSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function channelSecretsEqual(expectedHash: string, providedSecret: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const provided = Buffer.from(hashChannelSecret(providedSecret), "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
