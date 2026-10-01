import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import QuotationBuilder from "@/components/admin/quotation-builder";
import { quotationRecordToDraft } from "@/lib/quotation";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetchFromCore(`/api/admin/quotations/${id}`);
  if (!res.ok) notFound();
  const quotation = await res.json();

  const draft = quotationRecordToDraft(quotation);

  return (
    <div className="admin-page">
      <AdminPageHeader
        eyebrow="Commercial"
        title={`Quotation: ${quotation.businessName}`}
        description="Update the quotation, change status, download the PDF, or delete it."
        actions={<Link href="/quotations" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to quotations</Link>}
      />

      <QuotationBuilder mode="edit" initialDraft={draft} />
    </div>
  );
}
