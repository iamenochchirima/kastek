import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function POST(req: Request) {
  const body = await req.json();
  return withBillingActor(async (actor) =>
    billingRequest(actor, "POST", "/admin/products", body),
  );
}
