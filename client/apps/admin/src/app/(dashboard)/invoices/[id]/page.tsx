import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import InvoiceBuilder from "@/components/admin/invoice-builder";
import InvoiceOperationsPanel from "@/components/admin/invoice-operations-panel";
import { invoiceRecordToDraft } from "@/lib/invoice";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetchFromCore(`/api/admin/invoices/${id}`);
  if (!res.ok) notFound();
  const invoice = await res.json();

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
          Update the invoice template, track the active billing cycle, and manage send and reminder follow-up.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px] items-start">
        <InvoiceBuilder mode="edit" initialDraft={draft} />
        <InvoiceOperationsPanel
          invoiceId={invoice.id}
          currentRun={invoice.currentRun}
          recentRuns={invoice.recentRuns}
          operations={invoice.operations}
        />
      </div>
    </div>
  );
}
