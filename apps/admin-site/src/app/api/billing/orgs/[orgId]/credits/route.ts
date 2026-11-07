import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function GET(_req: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "GET",
      `/admin/tenants/growth/${encodeURIComponent(orgId)}/credits`,
    ),
  );
}
