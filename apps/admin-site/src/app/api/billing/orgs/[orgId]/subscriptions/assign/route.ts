import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/tenants/growth/${encodeURIComponent(decodeURIComponent(orgId))}/subscriptions/assign`,
      body,
    ),
  );
}
