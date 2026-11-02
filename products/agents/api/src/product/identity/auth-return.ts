import { createHash,createHmac,timingSafeEqual } from "node:crypto";

const lifetime = 600_000;

export function safeApplicationDestination(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048 || /[%\\\s\u0000-\u001f\u007f]/u.test(value)) return "/app";
  if (!/^\/app(?:\/|\?|$)/u.test(value) || value.includes("//")) return "/app";
  const url = new URL(value, "https://agents.invalid");
  if (url.origin !== "https://agents.invalid" || !/^\/app(?:\/|$)/u.test(url.pathname)) return "/app";
  if (url.pathname.split("/").some(segment => ["auth", "login", "signup", ".", ".."].includes(segment))) return "/app";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The database login transaction remains the one-use authority; this cookie only carries its destination. */
export class LoginReturnCookie {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error("Login return signing secret must contain at least 32 characters");
  }

  sign(token: string, destination: unknown, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ transaction: this.transaction(token), destination: safeApplicationDestination(destination), expires: now + lifetime })).toString("base64url");
    return `${body}.${this.signature(body).toString("base64url")}`;
  }

  read(cookie: unknown, token: unknown, now = Date.now()): string {
    if (typeof cookie !== "string" || cookie.length > 4_096 || typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return "/app";
    const parts = cookie.split(".");
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/u.test(part))) return "/app";
    const body = parts[0]!, supplied = parts[1]!;
    const signature = Buffer.from(supplied, "base64url"), expected = this.signature(body);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return "/app";
    try {
      const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (value.transaction !== this.transaction(token) || !Number.isSafeInteger(value.expires) || value.expires <= now || value.expires > now + lifetime) return "/app";
      return safeApplicationDestination(value.destination);
    } catch { return "/app"; }
  }

  private transaction(token: string): string { return createHash("sha256").update(token).digest("base64url"); }
  private signature(body: string): Buffer { return createHmac("sha256", this.secret).update(body).digest(); }
}
