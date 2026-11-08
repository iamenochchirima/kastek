import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const { versionId } = await params;
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "PUT",
      `/admin/plan-versions/${encodeURIComponent(decodeURIComponent(versionId))}/entitlements`,
      body,
    ),
  );
}
