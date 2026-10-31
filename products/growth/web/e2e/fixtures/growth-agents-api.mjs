import http from "node:http";
import { communicationsFixture } from "./communications-api.mjs";
import { campaignFixture } from "./campaigns-api.mjs";
import { randomUUID } from "node:crypto";
import { analyticsCatalogFixture, analyticsReportFixture } from "../analytics-fixtures.ts";

const businessOne = "growth-fixture-one";
const businessTwo = "growth-fixture-two";
const userId = "growth-fixture-user";
const now = () => new Date().toISOString();
const conversations = new Map();
const messages = new Map();
const tasks = new Map();
const reviews = new Map();
const requests = new Map();
const attempts = [];
const instructionAttempts = [];
const continuationAttempts = [];
let loseInstructionAcknowledgement = false;
let active = true;
const features = [
  { id: "assistant", name: "Growth assistant", description: "Guidance and help with your business.", ready: true, reasons: [] },
  { id: "content", name: "Content", description: "Draft and improve your posts.", ready: true, reasons: [] },
  { id: "campaigns", name: "Campaigns", description: "Review WhatsApp campaign performance.", ready: true, reasons: [] },
  { id: "research", name: "Research", description: "Find answers in approved business sources.", ready: false, reasons: [{ code: "sources_required", message: "Approved sources required", route: "/workspace/settings" }] },
].map((feature) => ({ ...feature, model: { label: "Business model", provider: "fixture", modelId: "fixture" } }));
function create(featureId, businessId, context = null, title = "New conversation") {
  const conversation = { id: randomUUID(), featureId, title, context, contextDisplay: context ? { title: ({ whatsapp_campaign: "Weekend campaign", content_post: "Summer post", analytics_report: "Overview report", workspace: "Current business" })[context.kind] } : undefined, createdAt: now(), updatedAt: now(), businessId };
  conversations.set(conversation.id, conversation); messages.set(conversation.id, []); return conversation;
}
const seed = create("assistant", businessOne, { kind: "workspace" }, "Plan this week's work");
messages.set(seed.id, [{ id: "welcome-user", role: "user", text: "What should we work on?", createdAt: now() }, { id: "welcome-agent", role: "assistant", text: "Let's review your campaign and prepare a content draft.", createdAt: now(), sources: [{ id: "workspace", title: "Business overview", route: "/workspace" }] }]);
create("assistant", businessTwo, null, "Second business conversation");
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); }
function payload(request) { return new Promise((resolve, reject) => { let value = ""; request.on("data", (chunk) => { value += chunk; if (value.length > 1_000_000) reject(new Error("oversized fixture request")); }); request.on("end", () => { try { resolve(value ? JSON.parse(value) : {}); } catch { reject(new Error("invalid body")); } }); }); }
function rows(map, businessId) { return [...map.values()].filter((value) => value.businessId === businessId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
function scope(request) { const cookie = request.headers.cookie || ""; return cookie.includes(`kasitek_active_org=${businessTwo}`) ? businessTwo : businessOne; }
const migration = process.env.GROWTH_MIGRATION_FIXTURE === "1";
const profile = { name: "Fixture user", email: "fixture@example.test", phone: null, image: null, emailVerified: now() };
const developerKeys = [];
const bookingServices = [];
const migrationRequests = [];
const migrationContacts = [{ id: "fixture-contact", contactId: "fixture-contact", customerId: "fixture-customer", phone: "+27720001111", fullName: "Fixture contact", tags: [], location: "Cape Town", listLabel: "Migration list", metadata: {}, optIn: true, optInSource: "fixture-consent", optInDate: now(), excluded: false, notes: null, lastMarketingSent: null, createdAt: now(), updatedAt: now() }];
const migrationCampaigns = [];
const migrationPosts = [];
const migrationTemplates = [{ id: "fixture-template", templateName: "fixture_offer", language: "en", category: "MARKETING", status: "APPROVED", variablesCount: 0, header: null, body: "Fixture offer", footer: null, buttons: [], lastSynced: now(), connectionId: "fixture-whatsapp", connectionLabel: "Fixture WhatsApp" }];
const migrationMessages = [{ id: "fixture-inbound", sender: "customer", content: "Hello from the fixture", text: "Hello from the fixture", time: now(), status: "READ", contentType: "TEXT", attachments: [], reactions: [] }];
const fixtureWhatsapp = { id: "fixture-whatsapp", phoneNumberId: "fixture-number", phoneDisplayNumber: "+27 72 000 1111", wabaId: "fixture-waba", currentQualityRating: "GREEN", dailyLimitEstimate: 1000, verified: true, createdAt: now() };
const migrationInbox = { id: "fixture-inbox", channel: "whatsapp", customerName: "Fixture customer", phone: "+27720001111", lastMessageAt: now(), unreadCount: 0, starred: false, connectionId: fixtureWhatsapp.id, connectionLabel: "Fixture WhatsApp", lastMessage: "Hello from the fixture", status: "OPEN" };

const handleCampaignFixture = process.env.GROWTH_CAMPAIGNS_FIXTURE === "1" ? campaignFixture({ json, payload, now, contacts: migrationContacts, templates: migrationTemplates }) : null;

const handleCommunicationsFixture = process.env.GROWTH_COMMUNICATIONS_FIXTURE === "1" ? communicationsFixture({json,payload,now}) : null;

const fixturePlan = { key: "fixture-plan", productKey: "growth", name: "Fixture plan", interval: "MONTHLY", currency: "ZAR", amountMinor: 10000, creditsPerPeriod: 100, checkoutReady: true, entitlements: [] };
const developerConfig = { restBaseUrl: "https://growth.example/v1", mcpAvailable: false, mcpEndpoint: null, mcpPackage: null, clients: [] };
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1"); const path = url.pathname; const businessId = scope(request);
    if (migration) migrationRequests.push({ path, method: request.method });
    if (handleCommunicationsFixture && await handleCommunicationsFixture(request, response, url)) return;
    if (handleCampaignFixture && await handleCampaignFixture(request, response, url)) return;
    if (path === "/__fixture/migration") return json(response, 200, { requests: migrationRequests, profile, developerKeys, bookingServices, contacts: migrationContacts, campaigns: migrationCampaigns, templates: migrationTemplates, posts: migrationPosts, inboxMessages: migrationMessages });
    if (migration && path === "/api/auth/account") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html><head><meta name='robots' content='noindex'></head><body><h1>Account settings fixture</h1></body></html>"); return; }
    if (migration && path === "/api/profile") { if (request.method === "PATCH") Object.assign(profile, await payload(request)); return json(response, 200, { user: profile }); }
    if (migration && /^\/api\/orgs\/[^/]+\/(members|invitations)$/.test(path)) return json(response, 200, path.endsWith("/members") ? { members: [{ id: "member", userId, orgId: businessId, name: profile.name, email: profile.email, role: "OWNER", joinedAt: now(), image: null }] } : { invitations: [] });
    if (migration && path === "/api/developers") return json(response, 200, { apiKeys: developerKeys, config: developerConfig });
    if (migration && path === "/api/developers/api-keys" && request.method === "POST") { const input = await payload(request); const key = { id: randomUUID(), name: input.name, prefix: "fixture", scopes: ["api:read", "api:write"], status: "ACTIVE", createdById: userId, createdAt: now(), updatedAt: now(), expiresAt: null, lastUsedAt: null, revokedAt: null }; developerKeys.push(key); return json(response, 201, { key, secret: "fixture-not-a-real-credential" }); }
    if (migration && path === "/api/bookings/services") { if (request.method === "POST") { const input = await payload(request); const service = { ...input, id: randomUUID(), active: true }; bookingServices.push(service); return json(response, 201, { service }); } return json(response, 200, { services: bookingServices }); }
    if (migration && path === "/api/bookings") return json(response, 200, { bookings: [] });
    if (migration && path === "/api/billing/plans") return json(response, 200, { plans: [fixturePlan] });
    if (migration && path === "/api/billing/plans/fixture-plan") return json(response, 200, fixturePlan);
    if (migration && ["/api/billing/credits", "/api/billing/usage"].includes(path)) return json(response, 503, { error: "Billing ledger is not provided by this UI fixture" });
    if (migration && path === "/api/whatsapp/contacts") return json(response, 200, { contacts: migrationContacts, lists: [{ label: "Migration list", totalContacts: migrationContacts.length, primaryLocation: "Cape Town", metadataKeys: [] }], tagOptions: [], stats: { totalContacts: migrationContacts.length, optedInContacts: migrationContacts.length, excludedContacts: 0 } });
    if (migration && path === "/api/whatsapp/contacts/fixture-contact" && request.method === "PATCH") { Object.assign(migrationContacts[0], await payload(request), { updatedAt: now() }); return json(response, 200, { contact: migrationContacts[0] }); }

    if (migration && path === "/api/customers/fixture-customer") return json(response, 200, { customer: { id: "fixture-customer", displayName: "Fixture customer", createdAt: now() }, identities: [], contacts: [], conversations: [], campaigns: [], bookings: [], agentEvents: [] });
    if (migration && path === "/api/whatsapp/campaigns/preflight") { const input = await payload(request); const excluded = new Set(input.excludedContactIds || []); const eligible = migrationContacts.filter(c => c.optIn && !c.excluded && !excluded.has(c.id)); return json(response, 200, { totalContacts: migrationContacts.length, eligibleRecipients: eligible.length, skipped: { notOptedIn: 0, excluded: migrationContacts.length - eligible.length, cooldown: 0 } }); }
    if (migration && path === "/api/whatsapp/campaigns") { if (request.method === "POST") { const input = await payload(request); const campaign = { ...input, id: randomUUID(), status: "DRAFT", templateName: "fixture_offer", templateLanguage: "en", createdAt: now(), updatedAt: now(), totalRecipients: input.batchSize, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0, blockedCount: 0, unsubscribedCount: 0, connectionLabel: "Fixture WhatsApp", listLabel: "Migration list", templateStatus: "APPROVED" }; migrationCampaigns.push(campaign); return json(response, 201, { campaign, createdRecipients: input.batchSize }); } return json(response, 200, { campaigns: migrationCampaigns }); }
    if (migration && request.method === "GET" && /^\/api\/whatsapp\/campaigns\/[^/]+$/.test(path)) {
      const campaign = migrationCampaigns.find(c => c.id === path.split("/").at(-1));
      if (campaign) return json(response, 200, { campaign: { campaign, recipients: migrationContacts.map(c => ({ id: `${campaign.id}-${c.id}`, contactId: c.id, contactFullName: c.fullName, contactPhone: c.phone, contactListLabel: c.listLabel, status: "PENDING", createdAt: now(), updatedAt: now() })) } });
    }
    if (migration && path === "/api/whatsapp/templates") { if (request.method === "POST") { const input = await payload(request); const template = { ...input, id: randomUUID(), status: "PENDING", variablesCount: 0, buttons: [], lastSynced: now(), connectionLabel: "Fixture WhatsApp" }; migrationTemplates.push(template); return json(response, 201, template); } return json(response, 200, { templates: migrationTemplates }); }
    if (migration && path === "/api/whatsapp/connections") return json(response, 200, { connections: [fixtureWhatsapp] });
    if (migration && path === "/api/connections") return json(response, 200, { connections: [{ id: fixtureWhatsapp.id, provider: "WHATSAPP", externalAccountId: "fixture-number", displayName: "Fixture WhatsApp", handle: null, status: "CONNECTED", credentialStatus: "VALID", healthStatus: "HEALTHY", webhookStatus: "VERIFIED", metadata: {}, capabilities: [], permissions: [], consumers: ["inbox", "campaigns"], createdAt: now(), updatedAt: now() }] });
    if (migration && path === "/api/email/connections") return json(response, 200, { connections: [] });
    if (migration && path === "/api/social/channels") return json(response, 200, { channels: [{ id: "fixture-social", platform: "FACEBOOK", status: "CONNECTED", display_name: "Fixture Facebook Page", displayName: "Fixture Facebook Page", handle: "fixture", external_id: "fixture-page", scopes: [], metadata: {} }] });
    if (migration && path === "/api/inbox/conversations") return json(response, 200, { conversations: [migrationInbox] });
    if (migration && path === "/api/inbox/fixture-inbox/read") return json(response, 200, { ok: true });
    if (migration && path === "/api/inbox/fixture-inbox/messages") { if (request.method === "POST") { const input = await payload(request); const message = { id: randomUUID(), sender: "bot", text: input.text, content: input.text, time: now(), status: "SENT", contentType: "TEXT", attachments: [], reactions: [] }; migrationMessages.push(message); migrationInbox.lastMessage = input.text; return json(response, 201, { messageId: message.id, status: "SENT", queued: false }); } return json(response, 200, { messages: migrationMessages, capabilities: { version: 1, text: true, reply: true, reaction: false, attachments: { image: false, video: false, audio: false, document: false, sticker: false }, providerDelete: false, deliveryReceipts: true, readReceipts: true } }); }
    if (migration && path === "/api/social/posts") { if (request.method === "POST") { const input = await payload(request); const post = { ...input, id: randomUUID(), userId, title: input.content.slice(0, 40), createdAt: now(), updatedAt: now(), scheduledFor: null, publishedAt: null, media: [], publishJobs: [] }; migrationPosts.push(post); return json(response, 201, { post }); } return json(response, 200, { posts: migrationPosts }); }
    if (migration && path === "/api/social/channels/fixture-social/identity") return json(response, 200, { channel: { display_name: "Fixture Facebook Page", username: "fixture" } });
    if (migration && path === "/api/whatsapp/calls") return json(response, 200, { calls: [] });
    if (migration && path === "/api/billing/checkout" && request.method === "POST") { const input = await payload(request); return json(response, 201, { reference: "fixture-receipt", authorizationUrl: `${process.env.GROWTH_WEB_ORIGIN}/billing?payment=complete&reference=fixture-receipt`, idempotencyKey: input.idempotencyKey }); }
    if (migration && path === "/api/billing/checkout/fixture-receipt/verify") return json(response, 200, { status: "completed" });
    if (migration && path === "/api/social/oauth/meta/start") { response.writeHead(302, { location: "/connections?error=fixture_provider_unavailable" }); response.end(); return; }
    if (migration && path === "/api/social/media") return json(response, 200, { media: [] });
    if (migration && path === "/api/calls") return json(response, 200, { calls: [] });
    if (migration && path === "/api/calls/summary") return json(response, 200, { days: 30, summary: { totalCalls: 0, inboundCalls: 0, outboundCalls: 0, ringingCalls: 0, activeCalls: 0, completedCalls: 0, missedCalls: 0, failedCalls: 0, rejectedCalls: 0, recentCalls: 0 }, trend: [] });
    if (migration && path === "/api/calls/providers") return json(response, 200, { providers: [{ provider: "TWILIO", configured: false, browserConfigured: false, requiredEnvironment: [] }] });
    if (migration && path === "/api/social/posts/fixture-post/activity") return json(response, 200, { activity: [] });
    if (migration && path === "/api/social/posts/fixture-post/publish-batch") return json(response, 200, { batch: null });
    if (migration && (path.startsWith("/api/invitations/") || path.startsWith("/api/early-access/invitations/"))) return json(response, 404, { error: "Invitation not found" });
    if (path === "/health") return json(response, 200, { ok: true });
    if (path === "/__fixture/attempts") return json(response, 200, { attempts, instructionAttempts, continuationAttempts, tasks: [...tasks.values()], conversations: [...conversations.values()] });
    if (path === "/__fixture/orchestration") {
      const input = await payload(request), task = tasks.get(input.taskId);
      if (!task) return json(response, 404, { error: "Fixture task missing" });
      if (input.loseInstructionAcknowledgement !== undefined) loseInstructionAcknowledgement = input.loseInstructionAcknowledgement;
      task.state = input.state || task.state; if (input.errorCode !== undefined) task.errorCode = input.errorCode; task.canSteer = input.canSteer ?? true; task.canContinue = input.canContinue ?? false;
      task.orchestration = { revision: 1, record: { objective: "Prepare a launch draft", steps: [{ id: "draft", title: "Compare specialist drafts", state: "in_progress" }], questions: ["Which audience?"], evidenceTaskIds: [] } };
      task.children = [{ id: "research-child", name: "Research", state: "completed" }, { id: "content-child", name: "Content", state: "working" }];
      task.updatedAt = now(); return json(response, 200, { task });
    }
    if (path === "/__fixture/research") { const input = await payload(request); features.find((feature) => feature.id === "research").ready = input.ready; return json(response, 200, { ok: true }); }
    if (path === "/__fixture/availability") { active = (await payload(request)).active; return json(response, 200, { ok: true }); }
    if (path === "/api/auth/me" && process.env.GROWTH_AGENTS_FIXTURE_REQUIRE_SESSION === "1" && !/(?:^|;\s*)kasitek_session=[^;]+/.test(request.headers.cookie || "")) return json(response, 401, { error: "Unauthorized" });
    if (path === "/api/auth/me") return json(response, 200, { user: { id: userId, name: "Fixture user", email: "fixture@example.test", image: "", emailVerified: now() } });
    if (path === "/api/orgs/set-active") {
      const input = await payload(request);
      const expected = new URL(process.env.GROWTH_WEB_ORIGIN || "http://127.0.0.1:3310");
      if (request.method !== "POST" || request.headers.origin !== expected.origin || request.headers.host !== expected.host) return json(response, 403, { error: "Forbidden" });
      if (![businessOne, businessTwo].includes(input.orgId)) return json(response, 403, { error: "Forbidden" });
      response.setHeader("set-cookie", `kasitek_active_org=${input.orgId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
      return json(response, 200, { ok: true });
    }
    if (path === "/api/orgs") return json(response, 200, { activeOrgId: businessId, orgs: [{ id: businessOne, name: "Luma Studio", slug: "luma", logo: null }, { id: businessTwo, name: "Another business", slug: "another", logo: null }] });
    if (path === "/api/onboarding") return json(response, 200, { needsOnboarding: false, canManage: true, profile: {} });
    if (path === "/api/workspace/summary") return json(response, 200, { summary: { socialPostCount: 0, connections: [], templateStatusMap: {}, campaignsAggregate: { totalCampaigns: 0, totalRecipients: 0, deliveredCount: 0, readCount: 0, failedCount: 0, blockedCount: 0 }, activeCampaigns: 0, recentCampaigns: [], contactsAggregate: { total: 0, optedIn: 0, excluded: 0 }, sendStatusMap: {}, reviewQueue: [] } });
    if (path === "/api/early-access/status") return json(response, 200, { earlyAccess: null });
    if (path === "/api/product-tour") return json(response, 200, { shouldShow: false, currentStep: 0 });
    if (path === "/api/billing/summary") return json(response, 200, { orgId: businessId, features: [], products: [], meters: [], manualGrants: [], payments: [], invoices: [] });
    if (path === "/api/whatsapp/inbox/unread-count") return json(response, 200, { unreadCount: 0 });
    if (path === "/api/auth/activity") return json(response, 200, { ok: true });
    if (path === "/api/realtime/whatsapp") { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.write(": fixture\n\n"); const timer = setInterval(() => response.write(": heartbeat\n\n"), 15000); request.on("close", () => clearInterval(timer)); return; }
    if (path === "/api/analytics/catalog") return json(response, 200, analyticsCatalogFixture());
    if (path === "/api/analytics/query") return json(response, 200, analyticsReportFixture());
    if (path === "/api/whatsapp/campaigns/fixture-campaign") return json(response, 200, { campaign: { campaign: { id: "fixture-campaign", name: "Weekend campaign", description: "Weekend customers", templateName: "weekend_offer", templateLanguage: "en", status: "DRAFT", totalRecipients: 0, sentCount: 0, deliveredCount: 0, readCount: 0, failedCount: 0, blockedCount: 0, unsubscribedCount: 0, createdAt: now(), updatedAt: now(), connectionLabel: "Luma WhatsApp" }, recipients: [] } });
    if (path === "/api/social/posts/fixture-post/insights") return json(response, 200, { postId: "fixture-post", title: "Summer post", contentPreview: "Summer offers", publishedAt: null, platforms: [], generatedAt: now() });
    if (path === "/api/social/posts/fixture-post") return json(response, 200, { post: { id: "fixture-post", userId, primaryChannelId: null, title: "Summer post", prompt: null, content: "Summer offers at Luma Studio.", channels: ["INSTAGRAM"], status: "DRAFT", scheduledFor: null, publishedAt: null, metadata: null, createdAt: now(), updatedAt: now(), variants: [], media: [], publishJobs: [] } });
    if (!path.startsWith("/api/agents")) return json(response, migration ? 501 : 200, migration ? { error: `UI fixture does not implement ${path}` } : { items: [] });
    if (!active) return json(response, 503, { error: "Agents are unavailable", code: "fixture_unavailable" });
    if (path === "/api/agents/bootstrap") return json(response, 200, { features, defaultFeatureId: "assistant", scope: { businessId, userId, businessName: businessId === businessOne ? "Luma Studio" : "Another business" }, model: { label: "Business model", ready: true } });
    if (path === "/api/agents/draft-destinations") return json(response, 200, { destinations: [{ id: "account-instagram", platform: "INSTAGRAM", label: "Luma Studio", ready: true }] });
    if (path === "/api/agents/conversations") {
      if (request.method === "POST") { const input = await payload(request); const key = `${businessId}:create:${input.requestId}`; if (requests.has(key)) return json(response, 200, requests.get(key)); const conversation = create(input.featureId, businessId, input.context || null); const result = { conversation }; requests.set(key, result); return json(response, 201, result); }
      const search = (url.searchParams.get("search") || "").toLowerCase(); const featureId = url.searchParams.get("featureId");
      return json(response, 200, { conversations: rows(conversations, businessId).filter((value) => (!featureId || value.featureId === featureId) && value.title.toLowerCase().includes(search)), nextCursor: null });
    }
    const conversationMatch = /^\/api\/agents\/conversations\/([^/]+)(?:\/(messages|context))?$/.exec(path);
    if (conversationMatch) {
      const conversation = conversations.get(conversationMatch[1]);
      if (!conversation || conversation.businessId !== businessId) return json(response, 404, { error: "Conversation unavailable" });
      if (!conversationMatch[2]) return json(response, 200, { conversation, messages: messages.get(conversation.id), nextCursor: null });
      const input = await payload(request);
      if (conversationMatch[2] === "context") return json(response, 200, { conversation: create(conversation.featureId, businessId, input.context, "New context") });
      const key = `${businessId}:turn:${input.requestId}`; attempts.push({ ...input, conversationId: conversation.id, businessId });
      if (requests.has(key)) return json(response, 200, { ...requests.get(key), replayed: true });
      conversation.title = input.text.slice(0, 70); conversation.updatedAt = now();
      const task = { id: randomUUID(), conversationId: conversation.id, featureId: conversation.featureId, state: input.text.includes("review") || conversation.featureId === "content" ? "waiting_review" : "working", input: input.text, output: null, errorCode: null, createdAt: now(), updatedAt: now(), businessId };
      tasks.set(task.id, task); messages.get(conversation.id).push({ id: randomUUID(), role: "user", text: input.text, createdAt: now(), taskId: task.id });
      if (task.state === "waiting_review") {
        const review = { id: randomUUID(), taskId: task.id, conversationId: conversation.id, featureId: conversation.featureId, kind: "content_draft", payloadDigest: "initial-digest", state: "proposed", draft: { title: "Weekend offer", content: "Visit Luma Studio this weekend.", channels: ["INSTAGRAM"], channelSelections: { INSTAGRAM: "account-instagram" } }, createdAt: now(), expiresAt: new Date(Date.now() + 3600000).toISOString(), result: null };
        reviews.set(review.id, review); task.reviewIds = [review.id];
      } else if (!input.text.includes("keep working")) setTimeout(() => { task.state = "completed"; task.output = "I reviewed the business context. Here is the next step for your work."; task.updatedAt = now(); messages.get(conversation.id).push({ id: randomUUID(), role: "assistant", text: task.output, createdAt: now(), taskId: task.id, sources: [{ id: "business", title: "Business overview", route: "/workspace" }] }); }, 250);
      const result = { task, replayed: false }; requests.set(key, result);
      if (input.text.includes("lost response")) { response.destroy(); return; }
      return json(response, 202, result);
    }
    if (path === "/api/agents/tasks") {
      let result = rows(tasks, businessId); const conversationId = url.searchParams.get("conversationId"); const state = url.searchParams.get("state"); const search = url.searchParams.get("search");
      if (conversationId) result = result.filter((task) => task.conversationId === conversationId);
      if (state) result = result.filter((task) => state === "active" ? ["accepted", "queued", "working", "waiting_review", "waiting_authority", "cancel_requested"].includes(task.state) : task.state === state);
      if (search) result = result.filter((task) => task.input.toLowerCase().includes(search.toLowerCase()));
      return json(response, 200, { tasks: result, nextCursor: null });
    }
    const specialistMatch = /^\/api\/agents\/tasks\/([^/]+)\/specialists\/([^/]+)\/result$/.exec(path);
    if (specialistMatch) {
      const task = tasks.get(specialistMatch[1]);
      if (!task || task.businessId !== businessId || !task.children?.some(child => child.id === specialistMatch[2])) return json(response, 404, { error: "Result unavailable" });
      const offset = Number(url.searchParams.get("offset") || 0), text = "Verified specialist findings. ".repeat(180);
      return json(response, 200, { taskId: specialistMatch[2], state: "completed", available: true, output: text.slice(offset, offset + 4096), nextOffset: offset + 4096 < text.length ? offset + 4096 : null });
    }
    const taskMatch = /^\/api\/agents\/tasks\/([^/]+)(?:\/(events|reviews|cancel|instructions|continue)(?:\/([^/]+)(?:\/(decision))?)?)?$/.exec(path);
    if (taskMatch) {
      const task = tasks.get(taskMatch[1]); if (!task || task.businessId !== businessId) return json(response, 404, { error: "Task unavailable" });
      if (!taskMatch[2]) return json(response, 200, { task });
      if (taskMatch[2] === "instructions") {
        const input = await payload(request); instructionAttempts.push({ ...input, taskId: task.id });
        const key = `${businessId}:instruction:${input.requestId}`;
        if (requests.has(key)) return json(response, 200, requests.get(key));
        if (!task.canSteer || !["working", "waiting_review", "waiting_authority"].includes(task.state)) return json(response, 409, { error: "Task no longer accepts instructions" });
        const result = { accepted: true }; requests.set(key, result);
        if (loseInstructionAcknowledgement) { loseInstructionAcknowledgement = false; response.destroy(); return; }
        return json(response, 200, result);
      }
      if (taskMatch[2] === "continue") {
        const input = await payload(request); continuationAttempts.push({ ...input, taskId: task.id });
        const key = `${businessId}:continuation:${input.requestId}`;
        if (requests.has(key)) return json(response, 200, requests.get(key));
        if (!task.canContinue) return json(response, 409, { error: "Task cannot continue" });
        task.canContinue = false; task.updatedAt = now();
        let continued = task;
        if (["incomplete", "failed"].includes(task.state)) {
          continued = { ...task, id: randomUUID(), workId: task.workId || task.id, priorTaskId: task.id,
            state: "working", errorCode: null, canSteer: true, createdAt: now(), updatedAt: now() };
          tasks.set(continued.id, continued);
        } else { task.state = "working"; task.canSteer = true; }
        const result = { task: continued }; requests.set(key, result); return json(response, 200, result);
      }
      if (taskMatch[2] === "events") return json(response, 200, { events: [{ id: `${task.id}:${task.state}`, taskId: task.id, type: "task.state", state: task.state, createdAt: task.updatedAt }], nextCursor: task.state });
      if (taskMatch[2] === "cancel") { task.state = "cancelled"; task.canSteer = false; task.canContinue = false; task.updatedAt = now(); return json(response, 200, { task }); }
      if (!taskMatch[3]) return json(response, 200, { reviews: [...reviews.values()].filter((value) => value.taskId === task.id) });
      const review = reviews.get(taskMatch[3]); if (!review || review.taskId !== task.id) return json(response, 404, { error: "Review unavailable" });
      const input = await payload(request);
      if (input.payloadDigest !== review.payloadDigest) return json(response, 409, { error: "Proposal changed" });
      if (taskMatch[4]) { if (review.state === "proposed") { review.state = input.decision === "approve" ? "saved" : "rejected"; if (input.decision === "approve") { review.result = { operationId: randomUUID(), reviewId: review.id, payloadDigest: review.payloadDigest, recordId: "saved-fixture-draft", revision: "1", route: "/content/posts/saved-fixture-draft", state: "saved", actorId: userId }; task.results = [{ id: "saved-fixture-draft", kind: "draft", title: "Weekend offer", route: review.result.route }]; } task.state = "completed"; task.updatedAt = now(); } return json(response, 200, { reviewId: review.id, state: review.state }); }
      review.state = "expired"; const replacement = { ...review, id: randomUUID(), draft: input.draft, payloadDigest: randomUUID(), state: "proposed" }; reviews.set(replacement.id, replacement); task.reviewIds = [replacement.id]; return json(response, 200, { review: replacement });
    }
    return json(response, 404, { error: "Unknown fixture route" });
  } catch (error) { return json(response, 500, { error: error.message }); }
});
server.listen(Number(process.env.GROWTH_AGENTS_FIXTURE_API_PORT || 4310), "127.0.0.1");
