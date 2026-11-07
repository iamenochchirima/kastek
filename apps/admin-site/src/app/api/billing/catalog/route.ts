import { billingRequest, withBillingActor } from "@/lib/billing-api";

export async function GET() {
  return withBillingActor(async (actor) => billingRequest(actor, "GET", "/admin/catalog"));
}
