import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(
  req: Request,
  {
    params,
  }: {
    params: Promise<{ accountId: string; subscriptionId: string }>;
  },
) {
  const { accountId, subscriptionId } = await params;
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(
      actor,
      "POST",
      `/admin/accounts/${encodeURIComponent(decodeURIComponent(accountId))}/subscriptions/${encodeURIComponent(decodeURIComponent(subscriptionId))}/trial/extend`,
      body,
    ),
  );
}
