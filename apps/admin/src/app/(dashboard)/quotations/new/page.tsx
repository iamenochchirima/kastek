import Link from "next/link";
import { prisma } from "@kasiai/database";
import QuotationBuilder from "@/components/admin/quotation-builder";
import { getDefaultQuotationDraft, getTemplateDraft } from "@/lib/quotation";

export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const params = await searchParams;
  const lead = params.leadId
    ? await prisma.quoteRequest.findUnique({ where: { id: params.leadId } })
    : null;

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
    <div className="max-w-5xl space-y-6">
      <div>
        <Link
          href="/quotations"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Quotations
        </Link>
        <h1 className="text-2xl font-bold text-text">New Quotation</h1>
        <p className="text-sm text-text-muted">
          Create a standalone quotation record. You can optionally prefill it from a lead.
        </p>
      </div>

      <QuotationBuilder mode="create" initialDraft={draft} />
    </div>
  );
}
