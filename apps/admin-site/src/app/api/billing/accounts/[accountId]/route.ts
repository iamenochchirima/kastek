import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "GET",
      `/admin/accounts/${encodeURIComponent(decodeURIComponent(accountId))}`,
    ),
  );
}
