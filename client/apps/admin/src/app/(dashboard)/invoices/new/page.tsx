import Link from "next/link";
import { fetchFromCore } from "@/lib/admin-auth";
import InvoiceBuilder from "@/components/admin/invoice-builder";
import { getDefaultInvoiceDraft, getTemplateDraft } from "@/lib/invoice";

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
    <div className="max-w-none space-y-6">
      <div>
        <Link
          href="/invoices"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Invoices
        </Link>
        <h1 className="text-2xl font-bold text-text">New Invoice</h1>
        <p className="text-sm text-text-muted">
          Create a standalone invoice record. You can optionally prefill it from a lead.
        </p>
      </div>

      <InvoiceBuilder mode="create" initialDraft={draft} />
    </div>
  );
}
