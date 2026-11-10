import type { EvalsConfig } from "../config.js";

export type SandboxBillingProduct = "agents" | "growth" | "agency";

const SANDBOX_PLANS: Record<SandboxBillingProduct, string> = {
  agents: "agents-sandbox-unlimited",
  growth: "growth-sandbox-unlimited",
  agency: "agency-sandbox-unlimited",
};

export interface SandboxBillingEntitlement {
  accountId: string;
  product: SandboxBillingProduct;
  planKey: string;
  planVersion: number;
  subscription: Record<string, unknown>;
}

export interface EnsureSandboxBillingInput {
  product: SandboxBillingProduct;
  tenantId: string;
  name: string;
  billingEmail: string;
  ownerIssuer?: string;
  ownerSubject?: string;
}

export function sandboxPlanKey(product: SandboxBillingProduct): string {
  return SANDBOX_PLANS[product];
}

export async function ensureSandboxBilling(
  config: EvalsConfig,
  input: EnsureSandboxBillingInput,
): Promise<SandboxBillingEntitlement> {
  if (!config.billingSandbox) {
    throw new Error("Sandbox billing is not configured");
  }
  const response = await fetch(`${config.billingSandbox.url}/internal/sandbox/entitlement`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-billing-sandbox-secret": config.billingSandbox.secret,
    },
    body: JSON.stringify({
      product: input.product,
      tenantId: input.tenantId,
      name: input.name,
      billingEmail: input.billingEmail,
      planKey: sandboxPlanKey(input.product),
      ...(input.ownerIssuer ? { ownerIssuer: input.ownerIssuer } : {}),
      ...(input.ownerSubject ? { ownerSubject: input.ownerSubject } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let value: Record<string, any> = {};
  try {
    value = text ? JSON.parse(text) as Record<string, any> : {};
  } catch {
    value = {};
  }
  if (!response.ok) {
    throw new Error(
      typeof value.error === "string"
        ? `Sandbox billing: ${value.error}`
        : `Sandbox billing failed with HTTP ${response.status}`,
    );
  }
  return value as SandboxBillingEntitlement;
}
