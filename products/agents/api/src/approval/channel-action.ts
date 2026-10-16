import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "ka_approval_";
const TOKEN_VERSION = 1 as const;
const COMPACT_SIGNATURE_BYTES = 12;

export type ChannelApprovalDecision = "approved" | "rejected";

/**
 * The action is deliberately compact: Telegram callback_data is limited to 64
 * bytes. The database record remains the source of truth for the run,
 * installation, binding, arguments hash, and approver identity.
 */
export interface ChannelApprovalActionClaims {
  v: typeof TOKEN_VERSION;
  typ: "agent_approval";
  approvalId: string;
  decision: ChannelApprovalDecision;
  exp: number;
}

export interface CreateChannelApprovalActionInput {
  approvalId: string;
  organizationId: string;
  installationId: string;
  runId: string;
  providerToolCallId: string;
  argumentsHash: string;
  bindingId: string;
  channelType: string;
  externalIdentity: string;
  externalConversationId: string;
  decision: ChannelApprovalDecision;
  expiresAt: string;
  now?: number;
}

export interface VerifyChannelApprovalActionExpected {
  approvalId?: string;
  decision?: ChannelApprovalDecision;
}

function sign(body: string, secret: string): string {
  if (!secret.trim()) throw new Error("Channel approval signing secret is not configured");
  return createHmac("sha256", secret).update(body).digest().subarray(0, COMPACT_SIGNATURE_BYTES).toString("base64url");
}

function uuidToCompact(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("Channel approval id must be a UUID");
  }
  return Buffer.from(normalized.replaceAll("-", ""), "hex").toString("base64url");
}

function compactToUuid(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 16) throw new Error("Invalid channel approval id");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createChannelApprovalActionToken(input: CreateChannelApprovalActionInput, secret: string): string {
  const expiresAt = Date.parse(input.expiresAt);
  const now = input.now ?? Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error("Channel approval action expiry must be in the future");
  const approvalId = uuidToCompact(input.approvalId);
  const decision = input.decision === "approved" ? "a" : "r";
  const exp = Math.floor(expiresAt / 1000);
  const body = `${approvalId}.${decision}.${exp}`;
  return `${TOKEN_PREFIX}${body}.${sign(body, secret)}`;
}

export function verifyChannelApprovalActionToken(
  token: string,
  secret: string,
  expected: VerifyChannelApprovalActionExpected = {},
  now = Date.now(),
): ChannelApprovalActionClaims {
  if (!token.startsWith(TOKEN_PREFIX)) throw new Error("Invalid channel approval action");
  const parts = token.slice(TOKEN_PREFIX.length).split(".");
  if (parts.length !== 4) throw new Error("Invalid channel approval action");
  const [compactApprovalId, compactDecision, compactExpiry, providedSignature] = parts;
  if (!compactApprovalId || !compactDecision || !compactExpiry || !providedSignature) throw new Error("Invalid channel approval action");
  const body = `${compactApprovalId}.${compactDecision}.${compactExpiry}`;
  const expectedSignature = sign(body, secret);
  const provided = Buffer.from(providedSignature, "utf8");
  const expectedBytes = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== expectedBytes.length || !timingSafeEqual(provided, expectedBytes)) {
    throw new Error("Invalid channel approval action signature");
  }
  const approvalId = compactToUuid(compactApprovalId);
  const decision = compactDecision === "a" ? "approved" : compactDecision === "r" ? "rejected" : undefined;
  const exp = Number(compactExpiry);
  if (!decision || !Number.isSafeInteger(exp) || exp * 1000 <= now) throw new Error("Channel approval action expired");
  if (expected.approvalId && expected.approvalId !== approvalId) throw new Error("Channel approval action approvalId mismatch");
  if (expected.decision && expected.decision !== decision) throw new Error("Channel approval action decision mismatch");
  return { v: TOKEN_VERSION, typ: "agent_approval", approvalId, decision, exp };
}

export function isChannelApprovalActionToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}
