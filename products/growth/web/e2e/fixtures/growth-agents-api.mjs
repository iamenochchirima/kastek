import http from "node:http";
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
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1"); const path = url.pathname; const businessId = scope(request);
    if (path === "/health") return json(response, 200, { ok: true });
    if (path === "/__fixture/attempts") return json(response, 200, { attempts, conversations: [...conversations.values()] });
    if (path === "/__fixture/research") { const input = await payload(request); features.find((feature) => feature.id === "research").ready = input.ready; return json(response, 200, { ok: true }); }
    if (path === "/__fixture/availability") { active = (await payload(request)).active; return json(response, 200, { ok: true }); }
    if (path === "/api/auth/me") return json(response, 200, { user: { id: userId, name: "Fixture user", email: "fixture@example.test", image: "", emailVerified: now() } });
    if (path === "/api/orgs") return json(response, 200, { orgs: [{ id: businessOne, name: "Luma Studio", slug: "luma", logo: null }, { id: businessTwo, name: "Another business", slug: "another", logo: null }] });
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
    if (!path.startsWith("/api/agents")) return json(response, 200, { items: [] });
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
    const taskMatch = /^\/api\/agents\/tasks\/([^/]+)(?:\/(events|reviews|cancel)(?:\/([^/]+)(?:\/(decision))?)?)?$/.exec(path);
    if (taskMatch) {
      const task = tasks.get(taskMatch[1]); if (!task || task.businessId !== businessId) return json(response, 404, { error: "Task unavailable" });
      if (!taskMatch[2]) return json(response, 200, { task });
      if (taskMatch[2] === "events") return json(response, 200, { events: [{ id: `${task.id}:${task.state}`, taskId: task.id, type: "task.state", state: task.state, createdAt: task.updatedAt }], nextCursor: task.state });
      if (taskMatch[2] === "cancel") { task.state = "cancelled"; task.updatedAt = now(); return json(response, 200, { task }); }
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
