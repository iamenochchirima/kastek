import Link from "next/link";
import OutreachEmailBrowser from "@/components/admin/outreach-email-browser";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { resolveOutreachDraftDirectory, loadOutreachFiles } from "@/lib/outreach-drafts";

type LeadRecord = import("@/lib/outreach-drafts").DraftLead;

function leadDedupeKey(lead: LeadRecord) {
  const website = (lead.website || "").trim().toLowerCase();
  const subject = (lead.subject || "").trim().toLowerCase();
  const business = (lead.business_name || "").trim().toLowerCase();
  if (website) {
    try {
      const domain = new URL(website).hostname.replace(/^www\./, "");
      return `${domain}|${subject || business}`;
    } catch {
      return `${website}|${subject || business}`;
    }
  }
  return `${business}|${subject}`;
}

function dedupeLeads(leads: LeadRecord[]) {
  const map = new Map<string, LeadRecord>();
  for (const lead of leads) {
    const key = leadDedupeKey(lead);
    if (!map.has(key)) {
      map.set(key, lead);
    }
  }
  return Array.from(map.values());
}

export default async function OutreachDraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ file?: string }>;
}) {
  const params = await searchParams;
  const {files,sourceError} = await resolveOutreachDraftDirectory().then(loadOutreachFiles).then(files=>({files,sourceError:""})).catch((error: Error) => ({files:[],sourceError:error.message}));

  const selectedKey =
    params.file && (params.file === "__all__" || files.some((file) => file.key === params.file))
      ? params.file
      : files[0]?.key;

  const selected = files.find((file) => file.key === selectedKey);
  const allLeads = dedupeLeads(files.flatMap((file) => file.leads));
  const displayLeads = selectedKey === "__all__" ? allLeads : selected?.leads || [];

  return (
    <div className="admin-page">
      <AdminPageHeader eyebrow="Outreach" title="Email drafts" description="Review generated email drafts before sending." actions={<Link href="/outreach" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to outreach</Link>} />

      {sourceError && <p role="alert">{sourceError}</p>}
      <OutreachEmailBrowser
        files={[
          {
            key: "__all__",
            label: "All Draft Files (combined)",
            leadCount: allLeads.length,
          },
          ...files.map((file) => ({
            key: file.key,
            label: file.label,
            leadCount: file.leadCount,
            generatedOn: file.generatedOn,
          })),
        ]}
        selectedFile={selectedKey || ""}
        selectedFileLabel={selectedKey === "__all__" ? "All Draft Files (combined)" : selected?.label}
        leads={displayLeads}
      />
    </div>
  );
}
