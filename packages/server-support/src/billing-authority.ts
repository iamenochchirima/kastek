import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  BillingEntitlementSnapshot,
  BillingProduct,
  SignedBillingSnapshot,
} from "@kasitek-labs/contracts";

export const BILLING_AUTHORITY_HEADER = "x-kasitek-billing-authority";
export const BILLING_SNAPSHOT_HEADER = "x-kasitek-billing-snapshot";
export const BILLING_AUTHORITY_AUDIENCE = "kasitek-billing";

export interface BillingAuthority {
  issuer: "kasitek-product";
  product: BillingProduct;
  audience: typeof BILLING_AUTHORITY_AUDIENCE;
  method: string;
  path: string;
  digest: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

export interface BillingAuthorityInput {
  secret: string;
  product: BillingProduct;
  method: string;
  path: string;
  body?: string;
  now?: number;
}

export interface BillingAuthorityVerification extends Omit<BillingAuthorityInput, "product"> {
  product?: BillingProduct;
  nonceStore?: {
    remember(nonce: string, expiresAt: number): Promise<boolean>;
  };
}

function secretKey(secret: string): string {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("Billing secrets require at least 32 bytes");
  return secret;
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function billingBodyDigest(body = ""): string {
  return createHash("sha256").update(body).digest("hex");
}

function signature(secret: string, payload: string): string {
  return createHmac("sha256", secretKey(secret))
    .update(payload)
    .digest("base64url");
}

export function createBillingAuthority(input: BillingAuthorityInput): string {
  const now = input.now ?? Date.now();
  const claims: BillingAuthority = {
    issuer: "kasitek-product",
    product: input.product,
    audience: BILLING_AUTHORITY_AUDIENCE,
    method: input.method.toUpperCase(),
    path: input.path.split("?")[0]!,
    digest: billingBodyDigest(input.body),
    issuedAt: now,
    expiresAt: now + 60_000,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(stableJson(claims)).toString("base64url");
  return `${payload}.${signature(input.secret, payload)}`;
}

export async function verifyBillingAuthority(
  token: string,
  input: BillingAuthorityVerification,
): Promise<BillingAuthority> {
  if (token.length > 8192) throw new Error("Invalid billing authority");
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra) throw new Error("Invalid billing authority");
  const expected = signature(input.secret, payload);
  const actual = Buffer.from(supplied, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  if (
    actual.length !== wanted.length ||
    !timingSafeEqual(actual, wanted)
  )
    throw new Error("Invalid billing authority");
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as BillingAuthority;
  const now = input.now ?? Date.now();
  if (
    claims.issuer !== "kasitek-product" ||
    claims.audience !== BILLING_AUTHORITY_AUDIENCE ||
    !["growth", "agents", "agency"].includes(claims.product) ||
    (input.product != null && claims.product !== input.product) ||
    claims.method !== input.method.toUpperCase() ||
    claims.path !== input.path.split("?")[0] ||
    claims.digest !== billingBodyDigest(input.body) ||
    !Number.isFinite(claims.issuedAt) ||
    !Number.isFinite(claims.expiresAt) ||
    claims.issuedAt > now + 5_000 ||
    claims.expiresAt <= now ||
    claims.expiresAt - claims.issuedAt > 60_000 ||
    typeof claims.nonce !== "string" ||
    claims.nonce.length < 8
  )
    throw new Error("Invalid billing authority");
  if (input.nonceStore) {
    if (!(await input.nonceStore.remember(claims.nonce, claims.expiresAt)))
      throw new Error("Billing authority replay");
  }
  return claims;
}

export function createSignedBillingSnapshot(
  snapshot: BillingEntitlementSnapshot,
  secret: string,
): SignedBillingSnapshot {
  const payload = Buffer.from(stableJson(snapshot)).toString("base64url");
  return { payload, signature: signature(secret, payload) };
}

export function verifySignedBillingSnapshot(
  signed: SignedBillingSnapshot,
  secret: string,
  now = Date.now(),
): BillingEntitlementSnapshot {
  const expected = signature(secret, signed.payload);
  const actual = Buffer.from(signed.signature, "base64url");
  const wanted = Buffer.from(expected, "base64url");
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
    throw new Error("Invalid billing snapshot signature");
  const snapshot = JSON.parse(
    Buffer.from(signed.payload, "base64url").toString("utf8"),
  ) as BillingEntitlementSnapshot;
  if (
    snapshot.version !== 1 ||
    !["growth", "agents", "agency"].includes(snapshot.product) ||
    typeof snapshot.accountId !== "string" ||
    typeof snapshot.tenantId !== "string" ||
    typeof snapshot.expiresAt !== "string" ||
    Date.parse(snapshot.expiresAt) <= now
  )
    throw new Error("Invalid billing snapshot");
  return snapshot;
}

export function billingSnapshotToken(
  snapshot: BillingEntitlementSnapshot,
  secret: string,
): string {
  const signed = createSignedBillingSnapshot(snapshot, secret);
  return `${signed.payload}.${signed.signature}`;
}

export function parseBillingSnapshotToken(
  token: string,
  secret: string,
  now = Date.now(),
): BillingEntitlementSnapshot {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra)
    throw new Error("Invalid billing snapshot");
  return verifySignedBillingSnapshot({ payload, signature }, secret, now);
}
