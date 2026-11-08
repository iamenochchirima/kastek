import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ planKey: string }> },
) {
  const { planKey } = await params;
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/plans/${encodeURIComponent(decodeURIComponent(planKey))}/versions`,
      body,
    ),
  );
}
