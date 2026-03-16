import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const source =
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ||
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY;

  if (!source) {
    throw new Error(
      "SOCIAL_TOKEN_ENCRYPTION_KEY or WHATSAPP_TOKEN_ENCRYPTION_KEY is required",
    );
  }

  return crypto.createHash("sha256").update(source).digest();
}

export function encryptSocialSecret(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSocialSecret(payload: string): string {
  const [ivB64, tagB64, encryptedB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Invalid encrypted token payload");
  }

  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

