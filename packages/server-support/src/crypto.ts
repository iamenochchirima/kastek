import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export class CryptoError extends Error {
  constructor(
    public readonly code: "invalid_payload" | "decrypt_failed" | "invalid_utf8",
    message: string,
  ) {
    super(message);
  }
}
export const generateToken = (bytesLength: number): string =>
  randomBytes(bytesLength).toString("base64url");
export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export const sha256Key = (value: string): Buffer =>
  createHash("sha256").update(value).digest();
export const sha256Base64Url = (value: string): string =>
  sha256Key(value).toString("base64url");
export function encryptWithAes256Gcm(
  secret: string,
  plaintext: string,
): string {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", sha256Key(secret), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), ciphertext]
    .map((value) => value.toString("base64"))
    .join(":");
}
function decodeBase64(value: string): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new CryptoError("invalid_payload", "invalid encrypted payload");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new CryptoError("invalid_payload", "invalid encrypted payload");
  return decoded;
}
export function decryptWithAes256Gcm(secret: string, payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 2 && parts.length !== 3)
    throw new CryptoError("invalid_payload", "invalid encrypted payload");
  const nonce = decodeBase64(parts[0]!);
  const combined =
    parts.length === 2
      ? decodeBase64(parts[1]!)
      : Buffer.concat([decodeBase64(parts[2]!), decodeBase64(parts[1]!)]);
  if (
    nonce.length !== 12 ||
    combined.length < 16 ||
    (parts.length === 3 && decodeBase64(parts[1]!).length !== 16)
  )
    throw new CryptoError("invalid_payload", "invalid encrypted payload");
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sha256Key(secret), nonce);
    decipher.setAuthTag(combined.subarray(-16));
    plaintext = Buffer.concat([
      decipher.update(combined.subarray(0, -16)),
      decipher.final(),
    ]);
  } catch {
    throw new CryptoError("decrypt_failed", "failed to decrypt payload");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new CryptoError("invalid_utf8", "failed to decode decrypted payload");
  }
}
