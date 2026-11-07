import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request) {
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/plans/${encodeURIComponent(String(body.planKey))}/entitlement`,
      { key: body.key, value: body.value },
    ),
  );
}
