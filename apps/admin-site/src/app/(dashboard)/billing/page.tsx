import { BillingCatalogManager } from "@/components/admin/billing-catalog-manager";
import { BillingCreditControls } from "@/components/admin/billing-credit-controls";
import { billingJson } from "@/lib/billing-api";
import { requireAdminSession } from "@/lib/admin-auth";
import { AdminPageHeader } from "@/components/admin/page-header";

export default async function BillingAdminPage() {
  const actor = await requireAdminSession();
  const catalog = await billingJson<{
    products?: unknown[];
    plans?: unknown[];
    entitlements?: unknown[];
    accessDefinitions?: unknown[];
  }>(actor, "GET", "/admin/catalog");
  return (
    <div className="admin-page">
      <AdminPageHeader
        title="Workspace billing"
        description="Manage catalog pricing, Paystack mappings, capabilities, and credit controls."
      />
      <BillingCatalogManager
        products={(catalog.products ?? []) as never[]}
        plans={(catalog.plans ?? []) as never[]}
        entitlements={(catalog.entitlements ?? []) as never[]}
        accessDefinitions={(catalog.accessDefinitions ?? []) as never[]}
      />
      <BillingCreditControls />
    </div>
  );
}
