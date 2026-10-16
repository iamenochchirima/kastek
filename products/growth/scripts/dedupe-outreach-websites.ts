import { prisma } from "../database/src/client";

type LeadRow = {
  id: string;
  campaignId: string;
  businessName: string;
  website: string | null;
  emailStatus: string;
  createdAt: Date;
  campaign: { name: string; category: string };
};

function normalizeWebsite(input: string | null | undefined) {
  if (!input) return "";
  const raw = input.trim().toLowerCase().replace(/[),.;]+$/g, "");
  try {
    const url = raw.startsWith("http://") || raw.startsWith("https://") ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.replace(/^www\./, "").trim();
  } catch {
    return raw
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .replace(/:\d+$/, "")
      .trim();
  }
}

const statusPriority: Record<string, number> = {
  interested: 6,
  replied: 5,
  sent: 4,
  pending: 3,
  bounced: 2,
  not_interested: 1,
};

function leadPriority(lead: LeadRow) {
  return statusPriority[String(lead.emailStatus || "").toLowerCase()] ?? 0;
}

function pickCanonical(leads: LeadRow[]) {
  // Business rule: if a website exists in Restaurants campaign, keep that record.
  const restaurantLead = leads.find((lead) =>
    /restaurants/i.test(lead.campaign?.name || "")
  );
  if (restaurantLead) return restaurantLead;

  return [...leads].sort((a, b) => {
    const p = leadPriority(b) - leadPriority(a);
    if (p !== 0) return p;
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

async function recalcCampaignCounters(campaignIds: string[]) {
  const uniqueCampaignIds = Array.from(new Set(campaignIds));
  for (const campaignId of uniqueCampaignIds) {
    const [totalLeads, emailsSent, replies] = await Promise.all([
      prisma.outreachLead.count({ where: { campaignId } }),
      prisma.outreachLead.count({ where: { campaignId, emailStatus: "sent" } }),
      prisma.outreachLead.count({ where: { campaignId, emailStatus: { in: ["replied", "interested"] } } }),
    ]);

    await prisma.outreachCampaign.update({
      where: { id: campaignId },
      data: { totalLeads, emailsSent, replies },
    });
  }
}

async function main() {
  const apply = process.argv.includes("--apply");

  const leads = (await prisma.outreachLead.findMany({
    where: { website: { not: null } },
    select: {
      id: true,
      campaignId: true,
      businessName: true,
      website: true,
      emailStatus: true,
      createdAt: true,
      campaign: { select: { name: true, category: true } },
    },
  })) as LeadRow[];

  const grouped = new Map<string, LeadRow[]>();
  for (const lead of leads) {
    const key = normalizeWebsite(lead.website);
    if (!key) continue;
    const arr = grouped.get(key) || [];
    arr.push(lead);
    grouped.set(key, arr);
  }

  const duplicateGroups = [...grouped.entries()].filter(([, arr]) => arr.length > 1);
  const duplicateLeadCount = duplicateGroups.reduce((sum, [, arr]) => sum + arr.length, 0);

  const toDelete: LeadRow[] = [];
  const kept: LeadRow[] = [];

  for (const [, arr] of duplicateGroups) {
    const canonical = pickCanonical(arr);
    kept.push(canonical);
    for (const lead of arr) {
      if (lead.id !== canonical.id) toDelete.push(lead);
    }
  }

  console.log(JSON.stringify({
    totalLeadsWithWebsite: leads.length,
    duplicateWebsiteGroups: duplicateGroups.length,
    leadsInDuplicateGroups: duplicateLeadCount,
    dedupeDeletes: toDelete.length,
    dedupeKeeps: kept.length,
    mode: apply ? "apply" : "dry-run",
  }, null, 2));

  const preview = duplicateGroups.slice(0, 20).map(([website, arr]) => ({
    website,
    count: arr.length,
    campaigns: Array.from(new Set(arr.map((l) => `${l.campaign.name} (${l.emailStatus})`))),
    keep: (() => {
      const c = pickCanonical(arr);
      return `${c.businessName} | ${c.campaign.name} | ${c.emailStatus}`;
    })(),
  }));

  console.log("\\nTop duplicate groups (first 20):");
  console.table(preview);

  if (!apply) return;

  if (toDelete.length === 0) {
    console.log("No duplicates to delete.");
    return;
  }

  const affectedCampaignIds = toDelete.map((l) => l.campaignId);

  const deleteIds = toDelete.map((l) => l.id);
  const chunkSize = 500;
  for (let i = 0; i < deleteIds.length; i += chunkSize) {
    const chunk = deleteIds.slice(i, i + chunkSize);
    await prisma.outreachLead.deleteMany({ where: { id: { in: chunk } } });
  }

  await recalcCampaignCounters(affectedCampaignIds);

  console.log(`Deleted ${toDelete.length} duplicate outreach leads.`);
  console.log(`Recalculated counters for ${new Set(affectedCampaignIds).size} campaigns.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
