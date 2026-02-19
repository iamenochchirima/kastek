import { prisma } from "@kasiai/database";
import { notFound } from "next/navigation";
import Link from "next/link";
import LeadForm from "@/components/admin/lead-form";

export default async function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const lead = await prisma.quoteRequest.findUnique({
    where: { id },
  });

  if (!lead) notFound();

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          href={`/leads/${lead.id}`}
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Lead
        </Link>
        <h1 className="text-2xl font-bold text-text">Edit: {lead.businessName}</h1>
      </div>
      <LeadForm
        initialData={{
          id: lead.id,
          businessName: lead.businessName,
          contactPerson: lead.contactPerson,
          phone: lead.phone,
          email: lead.email,
          businessType: lead.businessType,
          services: lead.services,
          description: lead.description || "",
          source: lead.source,
          status: lead.status,
          quoteAmount: lead.quoteAmount,
          followUpDate: lead.followUpDate
            ? lead.followUpDate.toISOString().split("T")[0]
            : "",
        }}
      />
    </div>
  );
}
