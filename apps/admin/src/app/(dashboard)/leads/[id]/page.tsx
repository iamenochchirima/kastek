import { prisma } from "@kasiai/database";
import { notFound } from "next/navigation";
import Link from "next/link";
import LeadNotes from "@/components/admin/lead-notes";
import LeadStatusUpdate from "@/components/admin/lead-status-update";
import LeadDeleteButton from "@/components/admin/lead-delete-button";

const SOURCE_LABELS: Record<string, string> = {
  website: "Website Form",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  cold_email: "Cold Email",
  referral: "Referral",
  whatsapp: "WhatsApp",
  walk_in: "Walk-in",
};

const SERVICE_LABELS: Record<string, string> = {
  whatsapp_chatbot: "WhatsApp Chatbot",
  website_chatbot: "Website Chatbot",
  voice_agent: "AI Voice Agent",
  custom_agent: "Custom AI Agent",
};

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const lead = await prisma.quoteRequest.findUnique({
    where: { id },
  });

  if (!lead) notFound();

  const notes = (lead.notes as { text: string; timestamp: string; adminUserName: string }[]) || [];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/leads"
            className="text-sm text-text-muted hover:text-text mb-1 inline-block"
          >
            &larr; Back to Leads
          </Link>
          <h1 className="text-2xl font-bold text-text">{lead.businessName}</h1>
          <p className="text-text-muted text-sm">
            Added {lead.createdAt.toLocaleDateString()} &middot;{" "}
            {SOURCE_LABELS[lead.source] || lead.source}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/quotations/new?leadId=${lead.id}`}
            className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors"
          >
            New Quotation
          </Link>
          <Link
            href={`/leads/${lead.id}/edit`}
            className="border border-border hover:bg-surface-overlay px-4 py-2 rounded-lg text-sm font-medium text-text transition-colors"
          >
            Edit
          </Link>
          <LeadDeleteButton leadId={lead.id} />
        </div>
      </div>

      {/* Status */}
      <div className="bg-surface-raised rounded-xl border border-border p-6">
        <h2 className="font-semibold mb-3 text-text">Status</h2>
        <LeadStatusUpdate leadId={lead.id} currentStatus={lead.status} />
      </div>

      {/* Contact + Business Details */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">Contact</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-text-faint uppercase tracking-wider">Person</dt>
              <dd className="text-sm font-medium text-text">{lead.contactPerson}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint uppercase tracking-wider">Email</dt>
              <dd className="text-sm">
                <a href={`mailto:${lead.email}`} className="text-primary hover:underline">
                  {lead.email}
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint uppercase tracking-wider">Phone</dt>
              <dd className="text-sm">
                <a href={`tel:${lead.phone}`} className="text-primary hover:underline">
                  {lead.phone}
                </a>
              </dd>
            </div>
          </dl>
        </div>

        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">Business</h2>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs text-text-faint uppercase tracking-wider">Type</dt>
              <dd className="text-sm capitalize text-text">{lead.businessType.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-text-faint uppercase tracking-wider">Services</dt>
              <dd className="flex flex-wrap gap-1.5 mt-1">
                {lead.services.map((s) => (
                  <span
                    key={s}
                    className="bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 rounded"
                  >
                    {SERVICE_LABELS[s] || s}
                  </span>
                ))}
                {lead.services.length === 0 && (
                  <span className="text-text-faint text-sm">None specified</span>
                )}
              </dd>
            </div>
            {lead.quoteAmount && (
              <div>
                <dt className="text-xs text-text-faint uppercase tracking-wider">Quote Amount</dt>
                <dd className="text-sm font-semibold text-text">R {lead.quoteAmount.toLocaleString()}</dd>
              </div>
            )}
            {lead.followUpDate && (
              <div>
                <dt className="text-xs text-text-faint uppercase tracking-wider">Follow-up Date</dt>
                <dd className="text-sm text-text">{lead.followUpDate.toLocaleDateString()}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Description */}
      {lead.description && (
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-2 text-text">Description</h2>
          <p className="text-sm text-text-muted whitespace-pre-wrap">{lead.description}</p>
        </div>
      )}

      {/* Notes */}
      <LeadNotes leadId={lead.id} notes={notes} />
    </div>
  );
}
