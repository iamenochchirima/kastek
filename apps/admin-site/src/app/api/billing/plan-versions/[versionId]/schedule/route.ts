import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ versionId: string }> },
) {
  const { versionId } = await params;
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/plan-versions/${encodeURIComponent(decodeURIComponent(versionId))}/schedule`,
      body,
    ),
  );
}
