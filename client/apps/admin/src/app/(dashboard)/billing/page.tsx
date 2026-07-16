import { BillingCatalogManager } from "@/components/admin/billing-catalog-manager";
import { fetchFromCore } from "@/lib/admin-auth";

export default async function BillingAdminPage() {
  const response = await fetchFromCore("/api/admin/billing/catalog");
  const catalog = response.ok ? await response.json() : { products: [], plans: [], entitlements: [] };
  return <div className="space-y-6 p-6"><div><h1 className="text-2xl font-bold text-text">Product billing</h1><p className="mt-1 text-sm text-text-muted">Manage sellable products, plan pricing, Paystack mappings, and entitlements.</p></div><BillingCatalogManager products={catalog.products ?? []} plans={catalog.plans ?? []} entitlements={catalog.entitlements ?? []} /></div>;
}
