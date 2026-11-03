import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PlatformError } from "../src/contracts/contracts";
import { registerInboxRoutes } from "../src/product/inbox/inbox-routes";
import type { InboxStore } from "../src/product/inbox/inbox-store";
import type { EnquiryStore } from "../src/capabilities/enquiries/enquiries";
import type { ToolReviewStore } from "../src/capabilities/reviews/tool-reviews";
import { registerCustomerFollowupConsent } from "../src/product/customer-followup/routes";
import type { CustomerFollowupChallenges } from "../src/product/customer-followup/challenges";

function fixture() {
  const app = Fastify(), deploymentId = randomUUID(), conversationId = randomUUID();
  const scope = { deploymentId, sessionId: randomUUID() };
  const conversation = { id: conversationId, organization_id: randomUUID(), version_id: randomUUID(), execution_conversation_id: randomUUID(), state: "automation_active", next_sequence: "1" };
  const ingress = vi.fn(async () => ({ conversation, message: { id: randomUUID(), sequence: "1", author_kind: "visitor", body: "Hello" }, replayed: false }));
  let requests = 0, authorized = true;
  const publicRate = vi.fn(async () => { if (++requests > 20) throw new PlatformError("RATE_LIMIT", 429, "Too many requests. Try again shortly"); });
  const resolveVisitor = async () => { if (!authorized) throw new PlatformError("WEBSITE_SESSION_REQUIRED", 401, "Website session required"); return scope; };
  const inbox = { readVisitor: vi.fn(async () => ({ conversation, messages: [] })), ingress, pool: { query: vi.fn(async () => ({ rows: [] })) } } as unknown as InboxStore;
  registerInboxRoutes(app, { inbox, enquiries: { listForPrincipal: async () => [] } as unknown as EnquiryStore,
    toolReviews: { listForPrincipal: async () => [] } as unknown as ToolReviewStore,
    resolveScope: async () => ({ organizationId: conversation.organization_id, accountId: randomUUID() }), resolveVisitor, publicRate });
  registerCustomerFollowupConsent(app, { challenges: { preference: async () => "none" } as unknown as CustomerFollowupChallenges, resolveVisitor, publicRate });
  const base = `/api/website/${deploymentId}/customer-conversations/${conversationId}`;
  return { app, base, publicRate, ingress, deny: () => { authorized = false; } };
}

describe("website polling and write budgets", () => {
  it.each(["enquiries", "tool-reviews", "followup"])("%s polls leave the visitor able to send a message", async path => {
    const f = fixture();
    try {
      for (let i = 0; i < 40; i++) expect((await f.app.inject({ method: "GET", url: `${f.base}/${path}` })).statusCode).toBe(200);
      expect(f.publicRate).not.toHaveBeenCalled();
      const sent = await f.app.inject({ method: "POST", url: `${f.base}/messages`, payload: { requestKey: randomUUID(), body: "Hello" } });
      expect(sent.statusCode).toBe(201); expect(f.publicRate).toHaveBeenCalledTimes(1); expect(f.ingress).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it("still rate-limits messages and confirmation writes", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 20; i++) expect((await f.app.inject({ method: "POST", url: `${f.base}/messages`, payload: { requestKey: randomUUID(), body: "Hello" } })).statusCode).toBe(201);
      for (const path of ["messages", `enquiries/${randomUUID()}/decision`, `tool-reviews/${randomUUID()}/decision`, "followup/request", "followup/verify", "followup/revoke", "followup/read"]) {
        expect((await f.app.inject({ method: "POST", url: `${f.base}/${path}`, payload: {} })).statusCode).toBe(429);
      }
      expect(f.ingress).toHaveBeenCalledTimes(20);
    } finally { await f.app.close(); }
  });
  it.each(["enquiries", "tool-reviews", "followup"])("%s polls still require an authenticated visitor", async path => {
    const f = fixture(); f.deny();
    try { expect((await f.app.inject({ method: "GET", url: `${f.base}/${path}` })).statusCode).toBe(401); expect(f.publicRate).not.toHaveBeenCalled(); }
    finally { await f.app.close(); }
  });
});
