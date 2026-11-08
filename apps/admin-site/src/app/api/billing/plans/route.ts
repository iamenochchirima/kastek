import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request) {
  const input = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(actor, "POST", "/admin/plans", input),
  );
}
