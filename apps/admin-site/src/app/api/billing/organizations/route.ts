import { billingJson, withBillingActor } from "@/lib/billing-api";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = new URLSearchParams({
    q: url.searchParams.get("q") ?? "",
    limit: url.searchParams.get("limit") ?? "25",
  });
  return withBillingActor(async (actor) => {
    const result = await billingJson<{
      organizations: Array<Record<string, unknown>>;
    }>(actor, "GET", `/admin/accounts?${query.toString()}`);
    return Response.json({
      organizations: result.organizations.map((row) => ({
        id: row.id,
        name: row.name,
        slug: String(row.id),
        ownerEmail: row.billingEmail ?? null,
        balance: Number(row.balance ?? 0),
        reservedBalance: Number(row.reservedBalance ?? 0),
      })),
    });
  });
}
