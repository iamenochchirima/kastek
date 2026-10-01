import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import OutreachEmailBrowser from "@/components/admin/outreach-email-browser";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { resolveOutreachDraftDirectory } from "@/lib/outreach-drafts";

type RawLead = {
  business_name?: string;
  businessName?: string;
  website?: string;
  contact_emails?: string[];
  contactEmails?: string[];
  subject?: string;
  email_body?: string;
  emailBody?: string;
  fit_assessment?: string;
  fitAssessment?: string;
};

type LeadRecord = {
  business_name: string;
  website: string;
  contact_emails: string[];
  subject: string;
  email_body: string;
  fit_assessment?: string;
  source_file?: string;
};

type FileRecord = {
  key: string;
  label: string;
  leadCount: number;
  generatedOn?: string;
  leads: LeadRecord[];
};

async function walkJsonFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return walkJsonFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        return [fullPath];
      }
      return [] as string[];
    })
  );
  return nested.flat();
}

function normalizeLead(raw: RawLead): LeadRecord | null {
  const business = raw.business_name || raw.businessName;
  const subject = raw.subject;
  const body = raw.email_body || raw.emailBody;
  if (!business || !subject || !body) return null;

  return {
    business_name: business,
    website: raw.website || "",
    contact_emails: raw.contact_emails || raw.contactEmails || [],
    subject,
    email_body: body,
    fit_assessment: raw.fit_assessment || raw.fitAssessment,
  };
}

async function loadOutreachFiles(baseDir: string): Promise<FileRecord[]> {
  try {
    const files = await walkJsonFiles(baseDir);

    const records = await Promise.all(
      files.map(async (fullPath) => {
        try {
          const content = await fs.readFile(fullPath, "utf8");
          const parsed = JSON.parse(content) as { generated_on?: string; leads?: RawLead[] };
          const leads = (parsed.leads || [])
            .map(normalizeLead)
            .filter((lead): lead is LeadRecord => lead !== null);
          if (leads.length === 0) return null;

          const relPath = path.relative(baseDir, fullPath);
          return {
            key: relPath,
            label: relPath,
            leadCount: leads.length,
            generatedOn: parsed.generated_on,
            leads: leads.map((lead) => ({
              ...lead,
              source_file: relPath,
            })),
          } as FileRecord;
        } catch {
          return null;
        }
      })
    );

    return records
      .filter((item): item is FileRecord => item !== null)
      .sort((a, b) => b.leadCount - a.leadCount || a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

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
  const baseDir = await resolveOutreachDraftDirectory();
  const files = await loadOutreachFiles(baseDir);

  const selectedKey =
    params.file && files.some((file) => file.key === params.file)
      ? params.file
      : files[0]?.key;

  const selected = files.find((file) => file.key === selectedKey);
  const allLeads = dedupeLeads(files.flatMap((file) => file.leads));
  const displayLeads = selectedKey === "__all__" ? allLeads : selected?.leads || [];

  return (
    <div className="admin-page">
      <AdminPageHeader eyebrow="Outreach" title="Email drafts" description="Review generated email drafts before sending." actions={<Link href="/outreach" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to outreach</Link>} />

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
