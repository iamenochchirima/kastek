import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";

/**
 * Billing entitlement checks required before admitting an Agents task. Composition provides the
 * implementation, so admission does not depend on the product billing module.
 */
export interface AdmissionEntitlements {
  snapshot(organizationId: string): Promise<BillingEntitlementSnapshot | null>;
  paidPlan(snapshot: BillingEntitlementSnapshot): boolean;
  assertManagedModelAllowance(snapshot: BillingEntitlementSnapshot | null, custody: string | undefined): void;
}

/** No billing service is configured, so admission continues without entitlement checks. */
export const unenforcedEntitlements: AdmissionEntitlements = {
  async snapshot() { return null; },
  paidPlan() { return false; },
  assertManagedModelAllowance() { /* no billing service */ },
};
