import fs from "node:fs/promises";
import path from "node:path";

export type DraftLead = { business_name: string; website: string; contact_emails: string[]; subject: string; email_body: string; fit_assessment?: string; source_file?: string };
export type DraftFile = { key: string; label: string; leadCount: number; generatedOn?: string; leads: DraftLead[] };
export function normalizeDraft(raw: Record<string, unknown>): DraftLead | null {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const business = text(raw.business_name ?? raw.businessName), subject = text(raw.subject), body = text(raw.email_body ?? raw.emailBody);
  if (!business || !subject || !body) return null;
  const emails = raw.contact_emails ?? raw.contactEmails;
  return { business_name: business, website: text(raw.website), subject, email_body: body,
    contact_emails: Array.isArray(emails) ? [...new Set(emails.map(text).map(v => v.toLowerCase()).filter(Boolean))] : [],
    fit_assessment: text(raw.fit_assessment ?? raw.fitAssessment) };
}
export async function resolveOutreachDraftDirectory() {
  const configured = process.env.OUTREACH_DRAFTS_DIR?.trim();
  if (!configured) throw new Error("OUTREACH_DRAFTS_DIR is not configured");
  return path.resolve(configured);
}
export async function loadOutreachFiles(baseDir: string): Promise<DraftFile[]> {
  const records: DraftFile[] = [];
  async function walk(dir: string) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = JSON.parse(await fs.readFile(full, "utf8")) as { generated_on?: string; generatedOn?: string; leads?: Record<string,unknown>[] };
      if (!Array.isArray(parsed.leads)) throw new Error(`Invalid draft file: ${path.relative(baseDir, full)}`);
      const key = path.relative(baseDir, full);
      const leads = parsed.leads.map(normalizeDraft).filter((v): v is DraftLead => Boolean(v)).map(v => ({...v, source_file:key}));
      records.push({ key, label:key, leadCount: leads.length, generatedOn: parsed.generated_on ?? parsed.generatedOn, leads });
    }
  }
  await walk(baseDir);
  return records;
}
