import { z } from "zod";

export const workflowResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("completed"), receiptId: z.string().min(1) }),
  z.strictObject({ state: z.enum(["waiting", "cancelled", "conflict", "uncertain", "failed"]), operationId: z.string().min(1), errorCode: z.string().optional() }),
]);
export const bookingIntentSchema = z.strictObject({
  resourceId: z.string().min(1).max(256), startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }),
  expectedProviderRevision: z.string().min(1).max(256), requestKey: z.string().min(1).max(128),
}).refine(value => new Date(value.endsAt).getTime() > new Date(value.startsAt).getTime(), "A booking must end after it starts");

export const bookingReceiptSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("confirmed"), intentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    providerBookingId: z.string().min(1).max(256), providerRevision: z.string().min(1).max(256), receiptId: z.string().min(1).max(256) }),
  z.strictObject({ state: z.literal("conflict"), intentDigest: z.string().regex(/^[a-f0-9]{64}$/), providerRevision: z.string().min(1).max(256) }),
  z.strictObject({ state: z.literal("uncertain"), intentDigest: z.string().regex(/^[a-f0-9]{64}$/), reconciliationKey: z.string().min(1).max(256) }),
]);
export const BOOKING_REQUIREMENTS = Object.freeze({
  id: "booking-v1", version: "1", available: false, unavailableCode: "BOOKING_PROVIDER_UNAVAILABLE",
  requiredStages: ["validate_slot", "confirm_intent", "claim_once", "provider_commit", "reconcile", "confirm_receipt"],
  approval: "exact_single_use", retry: "status_only", cancel: "reconcile_claimed",
  confirmationAuthority: "provider_receipt", conflictAuthority: "provider_revision",
  duplicatePrevention: "stable_intent_digest_and_provider_idempotency_key",
} as const);
