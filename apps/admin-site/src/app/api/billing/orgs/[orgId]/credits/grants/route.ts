import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const input = await req.json();
  const source =
    input.source === "PROMOTIONAL"
      ? "PROMOTION"
      : input.source === "MANUAL" || input.source === "COMPENSATION"
        ? "ADJUSTMENT"
        : input.source;
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/tenants/growth/${encodeURIComponent(orgId)}/credits/grant`,
      {
        amount: input.amount,
        source,
        endsAt: input.endsAt,
        reason: input.reason,
        reference: input.reference,
        idempotencyKey: input.idempotencyKey,
      },
    ),
  );
}
