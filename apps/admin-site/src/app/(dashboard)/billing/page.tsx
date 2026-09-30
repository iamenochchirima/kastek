import { BillingCatalogManager } from "@/components/admin/billing-catalog-manager";
import { BillingCreditControls } from "@/components/admin/billing-credit-controls";
import { ReferralSupportControls } from "@/components/admin/referral-support-controls";
import { fetchFromCore } from "@/lib/admin-auth";
import { AdminPageHeader } from "@/components/admin/page-header";

export default async function BillingAdminPage() {
  const response = await fetchFromCore("/api/admin/billing/catalog");
  const catalog = response.ok ? await response.json() : { products: [], plans: [], entitlements: [], accessDefinitions: [] };
  return <div className="admin-page"><AdminPageHeader title="Workspace billing" description="Manage offerings, plan pricing, Paystack mappings, capabilities, and usage limits." /><BillingCatalogManager products={catalog.products ?? []} plans={catalog.plans ?? []} entitlements={catalog.entitlements ?? []} accessDefinitions={catalog.accessDefinitions ?? []} /><BillingCreditControls /><ReferralSupportControls /></div>;
}
