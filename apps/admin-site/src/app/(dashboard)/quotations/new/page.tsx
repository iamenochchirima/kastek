import Link from "next/link";
import { fetchFromCore } from "@/lib/admin-auth";
import QuotationBuilder from "@/components/admin/quotation-builder";
import { getDefaultQuotationDraft, getTemplateDraft } from "@/lib/quotation";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

export default async function NewQuotationPage({
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
        ...getDefaultQuotationDraft({
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
        title="New quotation"
        description="Create a quotation, optionally prefilled from a lead."
        actions={<Link href="/quotations" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to quotations</Link>}
      />

      <QuotationBuilder mode="create" initialDraft={draft} />
    </div>
  );
}
