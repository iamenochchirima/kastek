import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ accountId: string; subscriptionId: string }>;
  },
) {
  const { accountId, subscriptionId } = await params;
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/accounts/${encodeURIComponent(decodeURIComponent(accountId))}/subscriptions/${encodeURIComponent(decodeURIComponent(subscriptionId))}/trial/end`,
      {},
    ),
  );
}
