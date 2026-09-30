import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import LeadNotes from "@/components/admin/lead-notes";
import LeadStatusUpdate from "@/components/admin/lead-status-update";
import LeadDeleteButton from "@/components/admin/lead-delete-button";
import { buttonClassName } from "@/components/ui/button";

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

  const res = await fetchFromCore(`/api/admin/leads/${id}`);
  if (!res.ok) notFound();

  const lead = await res.json();
  const notes: { text: string; timestamp: string; adminUserName: string }[] =
    Array.isArray(lead.notes) ? lead.notes : [];

  return (
    <div className="admin-page max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/leads"
            className="mb-1 inline-block text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; Back to Leads
          </Link>
          <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">{lead.businessName}</h1>
          <p className="text-sm text-muted-foreground">
            Added {new Date(lead.createdAt).toLocaleDateString()} &middot;{" "}
            {SOURCE_LABELS[lead.source] || lead.source}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/quotations/new?leadId=${lead.id}`}
            className={buttonClassName({ variant: "outline" })}
          >
            New Quotation
          </Link>
          <Link
            href={`/leads/${lead.id}/edit`}
            className={buttonClassName({ variant: "outline" })}
          >
            Edit
          </Link>
          <LeadDeleteButton leadId={lead.id} />
        </div>
      </div>

      {/* Status */}
      <div className="v-card p-[var(--density-card-padding)]">
        <h2 className="mb-3 text-base font-semibold tracking-[-0.01em] text-foreground">Status</h2>
        <LeadStatusUpdate leadId={lead.id} currentStatus={lead.status} />
      </div>

      {/* Contact + Business Details */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="mb-4 text-base font-semibold tracking-[-0.01em] text-foreground">Contact</h2>
          <dl className="space-y-3">
            <div>
              <dt className="v-label">Person</dt>
              <dd className="text-sm font-medium text-foreground">{lead.contactPerson}</dd>
            </div>
            <div>
              <dt className="v-label">Email</dt>
              <dd className="text-sm">
                <a href={`mailto:${lead.email}`} className="text-primary hover:underline">
                  {lead.email}
                </a>
              </dd>
            </div>
            <div>
              <dt className="v-label">Phone</dt>
              <dd className="text-sm">
                <a href={`tel:${lead.phone}`} className="text-primary hover:underline">
                  {lead.phone}
                </a>
              </dd>
            </div>
          </dl>
        </div>

        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="mb-4 text-base font-semibold tracking-[-0.01em] text-foreground">Business</h2>
          <dl className="space-y-3">
            <div>
              <dt className="v-label">Type</dt>
              <dd className="text-sm capitalize text-foreground">{lead.businessType.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="v-label">Services</dt>
              <dd className="flex flex-wrap gap-1.5 mt-1">
                {(lead.services as string[]).map((s) => (
                  <span
                    key={s}
                    className="rounded-sm bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                  >
                    {SERVICE_LABELS[s] || s}
                  </span>
                ))}
                {lead.services.length === 0 && (
                  <span className="text-sm text-muted-foreground">None specified</span>
                )}
              </dd>
            </div>
            {lead.quoteAmount && (
              <div>
                <dt className="v-label">Quote amount</dt>
                <dd className="text-sm font-semibold text-foreground">R {lead.quoteAmount.toLocaleString()}</dd>
              </div>
            )}
            {lead.followUpDate && (
              <div>
                <dt className="v-label">Follow-up date</dt>
                <dd className="text-sm text-foreground">{new Date(lead.followUpDate).toLocaleDateString()}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      {/* Description */}
      {lead.description && (
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="mb-2 text-base font-semibold tracking-[-0.01em] text-foreground">Description</h2>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.description}</p>
        </div>
      )}

      {/* Notes */}
      <LeadNotes leadId={lead.id} notes={notes} />
    </div>
  );
}
