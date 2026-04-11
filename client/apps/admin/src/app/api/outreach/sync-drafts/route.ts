import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";

type DraftLead = {
  website?: string;
  contact_emails?: string[];
  subject?: string;
  email_body?: string;
};

type OutreachLeadRow = {
  id: string;
  campaignId: string;
  businessName: string;
  website: string | null;
  emailAddress: string | null;
  emailTemplate: string | null;
  notes: string | null;
};

function normalizeEmails(input: string[] | null | undefined) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of input || []) {
    const email = String(value || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function normalizeWebsite(input: string | null | undefined) {
  if (!input) return "";
  const raw = input.trim().toLowerCase().replace(/[),.;]+$/g, "");
  try {
    const url = raw.startsWith("http://") || raw.startsWith("https://") ? new URL(raw) : new URL(`https://${raw}`);
    const host = url.hostname.replace(/^www\./, "");
    return host;
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .replace(/:\d+$/, "");
  }
}

function upsertSubjectInNotes(notes: string | null, subject: string) {
  const marker = "OUTREACH_SUBJECT::";
  const existing = notes || "";
  if (existing.includes(marker)) {
    return existing.replace(/OUTREACH_SUBJECT::[^\n]*/g, `${marker}${subject}`);
  }
  return existing ? `${existing}\n${marker}${subject}` : `${marker}${subject}`;
}

async function resolveDraftDir() {
  const candidates = [
    path.join(process.cwd(), "local-work", "outreach-emails", "organized", "categories"),
    path.join(process.cwd(), "..", "..", "local-work", "outreach-emails", "organized", "categories"),
    path.join(process.cwd(), "..", "local-work", "outreach-emails", "organized", "categories"),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next
    }
  }
  return candidates[0];
}

async function fetchAllLeads(campaignId: string | null): Promise<OutreachLeadRow[]> {
  // Fetch campaigns first to get all campaign IDs when no specific campaign is given
  if (campaignId) {
    const res = await fetchFromCore(`/api/admin/outreach/${campaignId}/leads`);
    if (!res.ok) return [];
    const data = await res.json() as OutreachLeadRow[];
    return Array.isArray(data) ? data.filter((l) => l.website) : [];
  }

  // No campaign filter: fetch all campaigns then all their leads
  const campaignsRes = await fetchFromCore("/api/admin/outreach");
  if (!campaignsRes.ok) return [];
  const campaignsData = await campaignsRes.json() as Array<{ id: string }>;
  const campaigns = Array.isArray(campaignsData) ? campaignsData : [];

  const allLeads: OutreachLeadRow[] = [];
  for (const campaign of campaigns) {
    const res = await fetchFromCore(`/api/admin/outreach/${campaign.id}/leads`);
    if (!res.ok) continue;
    const data = await res.json() as OutreachLeadRow[];
    const filtered = Array.isArray(data) ? data.filter((l) => l.website) : [];
    allLeads.push(...filtered);
  }
  return allLeads;
}

export async function POST(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get("debug") === "1";
  const body = await req.json().catch(() => ({}));
  const campaignId =
    typeof body?.campaignId === "string" && body.campaignId.trim()
      ? body.campaignId.trim()
      : null;

  const draftsDir = await resolveDraftDir();
  const files = await fs.readdir(draftsDir).catch(() => []);
  const websiteMap = new Map<string, DraftLead>();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(draftsDir, file);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as { leads?: DraftLead[] };
      for (const lead of parsed.leads || []) {
        const key = normalizeWebsite(lead.website);
        if (!key || !lead.email_body?.trim()) continue;
        const existing = websiteMap.get(key);
        if (!existing || (lead.email_body?.length || 0) > (existing.email_body?.length || 0)) {
          websiteMap.set(key, lead);
        }
      }
    } catch {
      // ignore invalid file
    }
  }

  const leads = await fetchAllLeads(campaignId);

  let matched = 0;
  let updated = 0;
  const debugSamples: Array<Record<string, string | boolean | number | null>> = [];
  const unmatchedKeys: string[] = [];

  for (const lead of leads) {
    const key = normalizeWebsite(lead.website);
    const draft = websiteMap.get(key);
    if (debug && debugSamples.length < 60) {
      debugSamples.push({
        dbWebsite: lead.website,
        normalizedDbKey: key,
        matched: Boolean(draft),
        draftWebsite: draft?.website || null,
        hasDraftEmail: Boolean((draft?.contact_emails || []).length),
        hasDraftBody: Boolean(draft?.email_body?.trim()),
      });
    }
    if (!draft) {
      if (debug && unmatchedKeys.length < 120) {
        unmatchedKeys.push(key);
      }
      continue;
    }
    matched += 1;

    const draftEmails = normalizeEmails(draft.contact_emails);
    const emailAddress = draftEmails[0] || null;
    const emailTemplate = draft.email_body?.trim() || null;
    const subject = draft.subject?.trim() || "";

    if (!emailTemplate) continue;

    const patchBody: Record<string, unknown> = { emailTemplate };
    if (emailAddress) patchBody.emailAddress = emailAddress;
    if (subject) patchBody.notes = upsertSubjectInNotes(lead.notes, subject);

    await fetchFromCore(`/api/admin/outreach/${lead.campaignId}/leads/${lead.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patchBody),
    });
    updated += 1;
  }

  const draftKeySamples = debug ? Array.from(websiteMap.keys()).slice(0, 80) : [];
  const dbKeySamples = debug ? leads.map((l) => normalizeWebsite(l.website)).slice(0, 80) : [];

  return NextResponse.json({
    ok: true,
    campaignId,
    draftWebsites: websiteMap.size,
    dbLeadsWithWebsite: leads.length,
    matched,
    updated,
    ...(debug
      ? {
          draftKeySamples,
          dbKeySamples,
          debugSamples,
          unmatchedSamples: unmatchedKeys.slice(0, 80),
        }
      : {}),
  });
}

export async function GET(req: Request) {
  const admin = await getAdminSession();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const debug = searchParams.get("debug") === "1";
  const campaignId = searchParams.get("campaignId");
  const limit = Math.min(2000, Math.max(10, Number(searchParams.get("limit") || 300)));
  const includeDraftData = searchParams.get("includeDraftData") === "1";

  const draftsDir = await resolveDraftDir();
  const files = await fs.readdir(draftsDir).catch(() => []);
  const websiteMap = new Map<string, DraftLead>();

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fullPath = path.join(draftsDir, file);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = JSON.parse(raw) as { leads?: DraftLead[] };
      for (const lead of parsed.leads || []) {
        const key = normalizeWebsite(lead.website);
        if (!key || !lead.email_body?.trim()) continue;
        const existing = websiteMap.get(key);
        if (!existing || (lead.email_body?.length || 0) > (existing.email_body?.length || 0)) {
          websiteMap.set(key, lead);
        }
      }
    } catch {
      // ignore
    }
  }

  const allLeads = await fetchAllLeads(campaignId);
  const leads = allLeads.slice(0, limit);

  const debugSamples = leads.map((lead) => {
    const normalizedDbKey = normalizeWebsite(lead.website);
    const draft = websiteMap.get(normalizedDbKey);
    const dbSubject = (lead.notes || "").match(/OUTREACH_SUBJECT::([^\n]+)/)?.[1]?.trim() || "";
    const draftEmails = normalizeEmails(draft?.contact_emails || []);
    const effectiveEmail = lead.emailAddress?.trim() || draftEmails[0] || "";
    const effectiveEmails = draftEmails.length
      ? draftEmails
      : effectiveEmail
        ? [effectiveEmail]
        : [];
    const effectiveTemplate = lead.emailTemplate?.trim() || draft?.email_body?.trim() || "";
    const effectiveSubject = dbSubject || draft?.subject?.trim() || "";
    return {
      leadId: lead.id,
      businessName: lead.businessName,
      dbWebsite: lead.website,
      normalizedDbKey,
      matched: Boolean(draft),
      draftWebsite: draft?.website || null,
      draftEmail: (draft?.contact_emails || [])[0] || null,
      draftSubject: draft?.subject || null,
      hasDraftBody: Boolean(draft?.email_body?.trim()),
      dbHasEmail: Boolean(lead.emailAddress?.trim()),
      dbHasTemplate: Boolean(lead.emailTemplate?.trim()),
      dbHasSubject: Boolean(dbSubject),
      effectiveHasEmail: Boolean(effectiveEmail),
      effectiveHasTemplate: Boolean(effectiveTemplate),
      effectiveHasSubject: Boolean(effectiveSubject),
      ...(includeDraftData
        ? {
            effectiveEmail,
            effectiveEmails,
            effectiveTemplate,
            effectiveSubject,
          }
        : {}),
    };
  });

  const matched = debugSamples.filter((s) => s.matched).length;
  const unmatched = debugSamples.length - matched;

  return NextResponse.json({
    ok: true,
    campaignId: campaignId || null,
    debug,
    limit,
    draftWebsites: websiteMap.size,
    dbLeadsChecked: debugSamples.length,
    matched,
    unmatched,
    draftKeySamples: Array.from(websiteMap.keys()).slice(0, 120),
    dbKeySamples: debugSamples.map((s) => s.normalizedDbKey).slice(0, 120),
    debugSamples,
    ...(includeDraftData ? { mergedLeads: debugSamples } : {}),
  });
}
