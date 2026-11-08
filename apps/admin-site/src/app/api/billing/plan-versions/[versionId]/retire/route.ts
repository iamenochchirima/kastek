import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const { versionId } = await params;
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/plan-versions/${encodeURIComponent(decodeURIComponent(versionId))}/retire`,
      {},
    ),
  );
}
