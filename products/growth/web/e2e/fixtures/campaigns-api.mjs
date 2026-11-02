import { randomUUID } from "node:crypto";

// In-memory provider boundary for Campaigns UI verification; never sends messages.
export function campaignFixture({ json, payload, now, contacts, templates }) {
  const campaigns = new Map();
  const recipients = new Map();
  const mutations = [];
  const contactRows = Array.from({ length: 65 }, (_, i) => ({ ...contacts[0], id: `campaign-membership-${i}`, contactId: `campaign-contact-${i}`, fullName: i === 0 ? "Thandi Mokoena" : `Customer ${i + 1}`, phone: `+2772000${String(i).padStart(4, "0")}`, optIn: i !== 1, excluded: i === 2, listLabel: "Migration list" }));
  function eligible(input) {
    const excluded = new Set(input.excludedContactIds || []);
    const skipped = { notOptedIn: 0, excluded: 0, cooldown: 0 };
    const rows = contactRows.filter(c => {
      if (excluded.has(c.contactId) || c.excluded) { skipped.excluded++; return false; }
      if (!c.optIn) { skipped.notOptedIn++; return false; }
      return true;
    });
    return { rows, skipped };
  }
  function add(id, name, status) {
    const campaign = { id, name, description: "Seasonal customer offer", status, templateName: "fixture_offer", templateLanguage: "en", templateBody: "Hi {{1}}, our spring offer is here. Reply for details.", templateHeader: "Spring offer", templateFooter: "KasiTek", variableMappings: [{ source: "contact", key: "fullName" }], templateButtons: [], connectionLabel: "KasiTek WhatsApp", listLabel: "Migration list", createdAt: now(), updatedAt: now(), scheduledAt: status === "SCHEDULED" ? new Date(Date.now() + 86400000).toISOString() : null, launchedAt: status === "DRAFT" ? null : now(), completedAt: status === "COMPLETED" ? now() : null, totalRecipients: 6, sentCount: status === "DRAFT" ? 0 : 4, deliveredCount: status === "DRAFT" ? 0 : 3, readCount: status === "DRAFT" ? 0 : 2, failedCount: status === "DRAFT" ? 0 : 1, blockedCount: 0, unsubscribedCount: 0, defaultBatchSize: 3 };
    campaigns.set(id, campaign);
    recipients.set(id, contactRows.slice(0, 6).map((c, i) => ({ id: `${id}-r${i}`, contactId: c.contactId, contactFullName: c.fullName, contactPhone: c.phone, contactListLabel: c.listLabel, contactLocation: c.location, contactMetadata: {}, status: status === "DRAFT" ? "PENDING" : ["READ", "DELIVERED", "SENT", "SENT", "FAILED", "PENDING"][i], sentAt: status === "DRAFT" ? null : now(), deliveredAt: i < 2 && status !== "DRAFT" ? now() : null, readAt: i === 0 && status !== "DRAFT" ? now() : null, failedAt: i === 4 && status !== "DRAFT" ? now() : null, errorCode: i === 4 ? "131047" : null, errorMessage: i === 4 ? "Recipient unavailable" : null, createdAt: now(), updatedAt: now() })));
    return campaign;
  }
  function reset() { campaigns.clear(); recipients.clear(); mutations.length = 0; add("spring-offer", "Spring offer", "SENDING"); add("customer-follow-up", "Customer follow-up", "DRAFT"); add("november-launch", "November launch", "SCHEDULED"); add("completed-campaign", "Winter customers", "COMPLETED"); }
  reset();
  return async function handle(request, response, url) {
    const path = url.pathname;
    if (path === "/__fixture/campaigns") {
      if (request.method === "POST") reset();
      json(response, 200, { campaigns: [...campaigns.values()], mutations }); return true;
    }
    if (path === "/api/whatsapp/contacts") {
      const start = Number(url.searchParams.get("cursor") || 0);
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), 50);
      json(response, 200, { contacts: contactRows.slice(start, start + limit), lists: [{ label: "Migration list", totalContacts: contactRows.length, primaryLocation: "Cape Town", metadataKeys: [] }], stats: { totalContacts: 65, filteredTotal: 65, optedInContacts: 64, excludedContacts: 1 }, tagOptions: [] }); return true;
    }
    if (path === "/api/whatsapp/campaigns/preflight") {
      const input = await payload(request), { rows, skipped } = eligible(input);
      json(response, 200, { totalContacts: contactRows.length, eligibleRecipients: rows.length, skipped }); return true;
    }
    if (path === "/api/whatsapp/campaigns") {
      if (request.method === "POST") {
        const input = await payload(request), { rows, skipped } = eligible(input);
        const c = add(randomUUID(), input.name, "DRAFT");
        Object.assign(c, { ...input, totalRecipients: rows.length, status: "DRAFT", templateName: templates[0].templateName });
        recipients.set(c.id, rows.map((x, i) => ({ id: `${c.id}-r${i}`, contactId: x.contactId, contactFullName: x.fullName, contactPhone: x.phone, contactListLabel: x.listLabel, status: "PENDING", createdAt: now(), updatedAt: now() })));
        mutations.push({ method: "POST", path, input }); json(response, 201, { campaign: c, createdRecipients: rows.length, skipped });
      } else json(response, 200, { campaigns: [...campaigns.values()] });
      return true;
    }
    const match = /^\/api\/whatsapp\/campaigns\/([^/]+)(?:\/(launch|summary))?$/.exec(path);
    if (!match) return false;
    const c = campaigns.get(match[1]);
    if (!c) { json(response, 404, { error: "Campaign not found" }); return true; }
    if (request.method === "GET") { json(response, 200, match[2] === "summary" ? { campaign: c } : { campaign: { campaign: c, recipients: recipients.get(c.id) } }); return true; }
    const input = await payload(request);
    mutations.push({ method: request.method, path, input });
    if (request.method === "DELETE") { campaigns.delete(c.id); recipients.delete(c.id); json(response, 200, { ok: true }); return true; }
    const action = match[2] === "launch" ? "launch" : input.action;
    c.status = ({ pause: "PAUSED", resume: "SENDING", cancel: "FAILED", retry_failed: "SENDING", send_more: "SENDING", launch: input.scheduledAt ? "SCHEDULED" : "SENDING" })[action] || c.status;
    if (input.scheduledAt) c.scheduledAt = input.scheduledAt;
    c.updatedAt = now();
    if (["launch", "send_more", "retry_failed"].includes(action)) {
      let count = 0;
      for (const r of recipients.get(c.id)) if ((action === "retry_failed" ? r.status === "FAILED" : r.status === "PENDING") && count++ < (input.batchSize || 3)) r.status = "QUEUED";
    }
    json(response, 200, { campaignId: c.id, status: c.status, queuedRecipients: input.batchSize || 3, retriedRecipients: 1 }); return true;
  };
}
