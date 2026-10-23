import { fetchFromCore } from "@/lib/admin-auth";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

type Organization = { id: string; name: string; slug: string; ownerEmail: string | null; balance: number };

export default async function GrowthOrganizations({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const response = await fetchFromCore(`/api/admin/billing/organizations?q=${encodeURIComponent(q)}&limit=25`);
  if (!response.ok) throw new Error("Growth organizations unavailable");
  const { organizations } = await response.json() as { organizations: Organization[] };
  return <div className="admin-page"><AdminPageHeader title="Growth organizations" /><form className="flex flex-wrap gap-2"><input name="q" defaultValue={q} aria-label="Search Growth organizations" placeholder="Name, email or ID" className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2" /><button className={buttonClassName()}>Search</button></form><p className="text-xs text-muted-foreground">Up to 25 matching organizations</p><div className="v-card divide-y divide-border">{organizations.length ? organizations.map((org) => <div key={org.id} className="space-y-1 p-4"><h2 className="font-medium">{org.name}</h2><p className="break-all text-sm text-muted-foreground">{org.ownerEmail || org.slug}</p><p className="break-all text-xs text-muted-foreground">{org.id}</p></div>) : <p className="p-4 text-sm text-muted-foreground">No matching organizations</p>}</div></div>;
}
