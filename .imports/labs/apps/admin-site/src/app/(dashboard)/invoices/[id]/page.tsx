import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import InvoiceBuilder from "@/components/admin/invoice-builder";
import InvoiceOperationsPanel from "@/components/admin/invoice-operations-panel";
import { invoiceRecordToDraft } from "@/lib/invoice";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

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
    <div className="admin-page">
      <AdminPageHeader
        eyebrow="Commercial"
        title={`Invoice: ${invoice.businessName}`}
        description="Update the invoice, track the billing cycle, and manage send and reminder follow-up."
        actions={<Link href="/invoices" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to invoices</Link>}
      />

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
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
