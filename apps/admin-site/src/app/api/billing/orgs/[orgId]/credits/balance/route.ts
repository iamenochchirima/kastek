import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const input = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/tenants/growth/${encodeURIComponent(orgId)}/credits/balance`,
      input,
    ),
  );
}
