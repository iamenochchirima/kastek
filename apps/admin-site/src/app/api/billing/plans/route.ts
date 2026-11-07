import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request) {
  const input = await req.json();
  const body = {
    product: input.productKey,
    key: input.key,
    name: input.name,
    amountMinor: input.amountMinor,
    currency: input.currency,
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: input.creditsPerPeriod,
    paystackPlanCode: input.paystackPlanCode ?? null,
    active: input.active,
  };
  return withBillingActor(async (actor) =>
    billingRequest(actor, "POST", "/admin/plans", body),
  );
}
