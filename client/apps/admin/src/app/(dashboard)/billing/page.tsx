import { BillingCatalogManager } from "@/components/admin/billing-catalog-manager";
import { fetchFromCore } from "@/lib/admin-auth";
import { AdminPageHeader } from "@/components/admin/page-header";

export default async function BillingAdminPage() {
  const response = await fetchFromCore("/api/admin/billing/catalog");
  const catalog = response.ok ? await response.json() : { products: [], plans: [], entitlements: [] };
  return <div className="admin-page"><AdminPageHeader title="Product billing" description="Manage sellable products, plan pricing, Paystack mappings, and entitlements." /><BillingCatalogManager products={catalog.products ?? []} plans={catalog.plans ?? []} entitlements={catalog.entitlements ?? []} /></div>;
}
