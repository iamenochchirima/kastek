import { prisma } from "@kasitek/database";
import { notFound } from "next/navigation";
import Link from "next/link";
import InvoiceBuilder from "@/components/admin/invoice-builder";
import { invoiceRecordToDraft } from "@/lib/invoice";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
  });

  if (!invoice) notFound();

  const draft = invoiceRecordToDraft(invoice);

  return (
    <div className="max-w-none space-y-6">
      <div>
        <Link
          href="/invoices"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Invoices
        </Link>
        <h1 className="text-2xl font-bold text-text">Invoice: {invoice.businessName}</h1>
        <p className="text-sm text-text-muted">
          Update this standalone invoice, change status, download PDF, or delete it.
        </p>
      </div>

      <InvoiceBuilder mode="edit" initialDraft={draft} />
    </div>
  );
}
