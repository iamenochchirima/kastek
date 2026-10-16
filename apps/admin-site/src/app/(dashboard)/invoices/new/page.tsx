import Link from "next/link";
import { fetchFromCore } from "@/lib/admin-auth";
import InvoiceBuilder from "@/components/admin/invoice-builder";
import { getDefaultInvoiceDraft, getTemplateDraft } from "@/lib/invoice";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const params = await searchParams;
  let lead: {
    id: string;
    businessName: string;
    contactPerson: string;
    email: string;
    phone: string;
    services: string[];
  } | null = null;

  if (params.leadId) {
    const res = await fetchFromCore(`/api/admin/leads/${params.leadId}`);
    if (res.ok) lead = await res.json();
  }

  const draft = lead
    ? {
        ...getDefaultInvoiceDraft({
          businessName: lead.businessName,
          contactPerson: lead.contactPerson,
          email: lead.email,
          phone: lead.phone,
          services: lead.services,
        }),
        quoteRequestId: lead.id,
      }
    : {
        ...getTemplateDraft("website_agent", {
          businessName: "",
          contactPerson: "",
          email: "",
          phone: "",
          services: ["website_chatbot"],
        }),
      };

  return (
    <div className="admin-page">
      <AdminPageHeader
        eyebrow="Commercial"
        title="New invoice"
        description="Create an invoice, optionally prefilled from a lead."
        actions={<Link href="/invoices" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to invoices</Link>}
      />

      <InvoiceBuilder mode="create" initialDraft={draft} />
    </div>
  );
}
