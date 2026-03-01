import { prisma } from "@kasiai/database";
import { notFound } from "next/navigation";
import Link from "next/link";
import QuotationBuilder from "@/components/admin/quotation-builder";
import { quotationRecordToDraft } from "@/lib/quotation";

export default async function QuotationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const quotation = await prisma.quotation.findUnique({
    where: { id },
  });

  if (!quotation) notFound();

  const draft = quotationRecordToDraft(quotation);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <Link
          href="/quotations"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Quotations
        </Link>
        <h1 className="text-2xl font-bold text-text">Quotation: {quotation.businessName}</h1>
        <p className="text-sm text-text-muted">
          Update this standalone quotation, change status, download PDF, or delete it.
        </p>
      </div>

      <QuotationBuilder mode="edit" initialDraft={draft} />
    </div>
  );
}
