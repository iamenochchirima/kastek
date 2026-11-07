import Link from "next/link";
import { requireAdminSession } from "@/lib/admin-auth";
import { billingJson } from "@/lib/billing-api";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

type Organization = {
  id: string;
  name: string;
  billingEmail: string | null;
  balance: string;
};

export default async function GrowthOrganizations({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q = "" } = await searchParams;
  const actor = await requireAdminSession();
  const query = new URLSearchParams({ q, limit: "25", product: "growth" });
  const result = await billingJson<{ organizations: Organization[] }>(
    actor,
    "GET",
    `/admin/accounts?${query.toString()}`,
  );
  return (
    <div className="admin-page">
      <AdminPageHeader title="Growth organizations" />
      <form className="flex flex-wrap gap-2">
        <input
          name="q"
          defaultValue={q}
          aria-label="Search Growth organizations"
          placeholder="Name, email or ID"
          className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2"
        />
        <button className={buttonClassName()}>Search</button>
      </form>
      <p className="text-xs text-muted-foreground">Up to 25 matching organizations</p>
      <div className="v-card divide-y divide-border">
        {result.organizations.length ? (
          result.organizations.map((org) => (
            <div key={org.id} className="space-y-1 p-4">
              <h2 className="font-medium">
                <Link
                  className="underline underline-offset-4"
                  href={`/customers/growth/${encodeURIComponent(org.id)}`}
                >
                  {org.name}
                </Link>
              </h2>
              <p className="break-all text-sm text-muted-foreground">
                {org.billingEmail || org.id}
              </p>
              <p className="break-all text-xs text-muted-foreground">{org.id}</p>
              <p className="text-xs text-muted-foreground">
                {Number(org.balance).toLocaleString()} credits
              </p>
            </div>
          ))
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No matching organizations</p>
        )}
      </div>
    </div>
  );
}
