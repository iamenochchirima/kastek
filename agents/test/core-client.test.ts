import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { KasitekCoreReadClient } from "../src/core/client";

const context = {
  organizationId: "org-1",
  agentId: "agent-1",
  agentVersionId: "version-1",
  installationId: "install-1",
  runId: "run-1",
  actorId: "user-1",
  correlationId: "corr-1",
};

describe("kasitek-core read boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends scoped service authentication and returns a customer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ customer: { id: "cust-1" }, identities: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test/",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    const result = await new KasitekCoreReadClient(config).getCustomer(context, "cust-1");
    expect(result.customer.id).toBe("cust-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://core.example.test/api/internal/agents/v1/customers/cust-1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer internal-token",
          "x-organization-id": "org-1",
          "x-actor-id": "user-1",
          "x-agent-run-id": "run-1",
          "x-correlation-id": "corr-1",
        }),
      }),
    );
  });

  it("rejects an unconfigured boundary instead of silently falling back", async () => {
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents" });
    await expect(new KasitekCoreReadClient(config).getCustomer(context, "cust-1")).rejects.toMatchObject({ code: "CORE_UNAVAILABLE" });
  });

  it("reads a workspace status snapshot through the scoped boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ organizationId: "org-1", connections: [] }), { status: 200 })));
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).getWorkspaceStatus(context)).resolves.toMatchObject({ organizationId: "org-1" });
    expect(fetch).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/workspace/status", expect.any(Object));
  });

  it("reads aggregate workspace reporting through the scoped boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      organizationId: "org-1",
      connections: { total: 1, byStatus: [{ status: "CONNECTED", count: 1 }] },
      content: { postCount: 2 },
      contacts: { total: 3, optedIn: 2, excluded: 0 },
      inbox: { conversationCount: 4, unreadConversationCount: 1 },
      bookings: { total: 5, byStatus: [] },
      campaigns: { total: 6, byStatus: [] },
      templates: { total: 7, byStatus: [] },
    }), { status: 200 })));
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).getWorkspaceReport(context)).resolves.toMatchObject({ contacts: { total: 3 }, campaigns: { total: 6 } });
    expect(fetch).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/workspace/report", expect.any(Object));
  });

  it("reads booking services through the typed internal capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ services: [{ id: "service-1", name: "Consultation", durationMinutes: 60, active: true }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listBookingServices(context)).resolves.toMatchObject({ services: [{ id: "service-1", durationMinutes: 60 }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/bookings/services");
    expect(init.headers).toMatchObject({ authorization: "Bearer internal-token", "x-organization-id": "org-1" });
  });

  it("passes a bounded booking-service inventory limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ services: [], total: 3, hasMore: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).listBookingServices(context, { limit: 25 })).resolves.toMatchObject({ total: 3, hasMore: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/bookings/services?limit=25");
  });

  it("reads bookings through the shared scoped booking query", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ bookings: [{ id: "booking-1" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listBookings(context)).resolves.toMatchObject({ bookings: [{ id: "booking-1" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/bookings", expect.any(Object));
  });

  it("passes bounded booking and campaign inventory limits", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      JSON.stringify(input.includes("/campaigns") ? { campaigns: [], total: 4, hasMore: true } : { bookings: [], total: 4, hasMore: true }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    const client = new KasitekCoreReadClient(config);
    await expect(client.listBookings(context, { limit: 25 })).resolves.toMatchObject({ total: 4, hasMore: true });
    await expect(client.listCampaigns(context, { limit: 50 })).resolves.toMatchObject({ total: 4, hasMore: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/bookings?limit=25");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/campaigns?limit=50");
  });

  it("reads one booking for an immutable approval preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ booking: { id: "booking-1", status: "SCHEDULED" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).getBooking(context, "booking/1")).resolves.toMatchObject({ booking: { id: "booking-1" } });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/bookings/booking%2F1");
  });

  it("delivers an approved channel message through the idempotent core boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ providerMessageId: "wamid-1", status: "sent" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).deliverChannelMessage({
      organizationId: context.organizationId,
      installationId: context.installationId,
      actorId: context.actorId,
      runId: context.runId,
      correlationId: context.correlationId,
      channelType: "whatsapp",
      externalConversationId: "conversation-1",
      text: "Hello from the approved agent",
    })).resolves.toEqual({ providerMessageId: "wamid-1", status: "sent" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/channels/deliver");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "idempotency-key": expect.any(String), "x-actor-id": "user-1" });
    expect(JSON.parse(String(init.body))).toEqual({ channelType: "whatsapp", externalConversationId: "conversation-1", text: "Hello from the approved agent" });
  });

  it("reads campaign inventory and a scoped campaign summary", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      JSON.stringify(input.includes("/campaigns/") ? { campaign: { id: "campaign-1", status: "COMPLETED" } } : { campaigns: [{ id: "campaign-1" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listCampaigns(context)).resolves.toMatchObject({ campaigns: [{ id: "campaign-1" }] });
    await expect(new KasitekCoreReadClient(config).getCampaignSummary(context, "campaign/1")).resolves.toMatchObject({ campaign: { status: "COMPLETED" } });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/campaigns/campaign%2F1");
  });

  it("reads templates with an optional approval-status filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ templates: [{ id: "template-1", status: "APPROVED" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listTemplates(context, "APPROVED")).resolves.toMatchObject({ templates: [{ status: "APPROVED" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/templates?status=APPROVED", expect.any(Object));
  });

  it("passes a bounded template projection limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ templates: [], total: 3, hasMore: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).listTemplates(context, "APPROVED", 25)).resolves.toMatchObject({ total: 3, hasMore: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/templates?status=APPROVED&limit=25");
  });

  it("reads filtered contacts through the organization-scoped capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contacts: [{ id: "contact-1" }], totalContacts: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listContacts(context, { q: "Ada", optIn: "true", limit: 25 })).resolves.toMatchObject({ totalContacts: 1 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/contacts?q=Ada&optIn=true&limit=25");
    expect(init.headers).toMatchObject({ authorization: "Bearer internal-token", "x-organization-id": "org-1" });
  });

  it("reads inbox conversations and a scoped message timeline", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      JSON.stringify(input.endsWith("/messages") ? { messages: [{ id: "message-1" }] } : { conversations: [{ id: "conversation-1" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listInboxConversations(context)).resolves.toMatchObject({ conversations: [{ id: "conversation-1" }] });
    await expect(new KasitekCoreReadClient(config).listInboxMessages(context, "conversation/1")).resolves.toMatchObject({ messages: [{ id: "message-1" }] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations/conversation%2F1/messages");
  });

  it("updates a contact through the approval-scoped idempotent core boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contact: { id: "contact-1", optIn: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).updateContact(context, "contact/1", { optIn: true })).resolves.toMatchObject({ contact: { optIn: true } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/contacts/contact%2F1");
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ authorization: "Bearer internal-token", "idempotency-key": expect.any(String) });
    expect(JSON.parse(String(init.body))).toEqual({ optIn: true });
  });

  it("updates and marks an inbox conversation through the scoped core boundary", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      JSON.stringify(input.endsWith("/read") ? { success: true } : { success: true, conversationId: "conversation-1", starred: true }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    const client = new KasitekCoreReadClient(config);
    await expect(client.updateInboxConversation(context, "conversation-1", { starred: true })).resolves.toMatchObject({ starred: true });
    await expect(client.markInboxConversationRead(context, "conversation-1")).resolves.toEqual({ success: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations/conversation-1");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations/conversation-1/read");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": expect.any(String) });
  });

  it("passes bounded inbox projections through the typed capability boundary", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(
      JSON.stringify(input.includes("/messages?") ? { messages: [{ id: "message-1" }], total: 3, hasMore: true } : { conversations: [{ id: "conversation-1" }], total: 3, hasMore: true }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    const client = new KasitekCoreReadClient(config);
    await expect(client.listInboxConversations(context, { limit: 25 })).resolves.toMatchObject({ total: 3, hasMore: true });
    await expect(client.listInboxMessages(context, "conversation-1", { limit: 50 })).resolves.toMatchObject({ total: 3, hasMore: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations?limit=25");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/inbox/conversations/conversation-1/messages?limit=50");
  });

  it("reads content through the same scoped core boundary", async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => new Response(JSON.stringify(input.endsWith("/post%2F1") ? { post: { id: "post-1", content: "Hello", channels: ["threads"], status: "DRAFT" } } : { posts: [{ id: "post-1", content: "Hello", channels: ["threads"], status: "DRAFT" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).listContentPosts(context)).resolves.toMatchObject({ posts: [{ id: "post-1" }] });
    expect(fetchMock).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/content/posts", expect.any(Object));
    await expect(new KasitekCoreReadClient(config).getContentPost(context, "post/1")).resolves.toMatchObject({ post: { id: "post-1" } });
    expect(fetchMock).toHaveBeenLastCalledWith("https://core.example.test/api/internal/agents/v1/content/posts/post%2F1", expect.any(Object));
  });

  it("updates a draft through the typed content capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ post: { id: "post-1", content: "Updated", channels: ["threads"], status: "DRAFT" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).updateContentDraft(context, "post-1", { content: "Updated" })).resolves.toMatchObject({ post: { status: "DRAFT" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/posts/post-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ content: "Updated", status: "DRAFT" });
  });

  it("creates content drafts with actor and idempotency propagation", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ post: { id: "post-2", content: "Draft", channels: ["threads"], status: "DRAFT" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    const draft = await new KasitekCoreReadClient(config).createContentDraft({ ...context, actorId: "user-1" }, { content: "Draft", channels: ["threads"] });
    expect(draft.post.id).toBe("post-2");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/posts");
    expect(init.headers).toMatchObject({ "x-actor-id": "user-1" });
    expect(init.headers).toHaveProperty("idempotency-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ content: "Draft", channels: ["threads"], status: "DRAFT" });
  });

  it("uploads channel image bytes through the trusted media boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      asset: { id: "asset-1", kind: "IMAGE", mimeType: "image/jpeg", byteSize: 4, processingStatus: "READY", scanStatus: "CLEAN" },
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).uploadContentMedia(context, {
      bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      mimeType: "image/jpeg",
      fileName: "launch image.jpg",
      source: "telegram",
      sourceKey: "telegram:connection:message:file",
    })).resolves.toMatchObject({ asset: { id: "asset-1" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/media");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "image/jpeg",
      "x-media-file-name": "launch%20image.jpg",
      "x-media-source": "telegram",
      "x-media-source-key": "telegram:connection:message:file",
    });
    expect(Buffer.from(init.body as ArrayBuffer).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it("deletes audio media through the trusted media boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).deleteContentMedia(context, "asset/audio 1")).resolves.toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/media/asset%2Faudio%201");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ "x-actor-id": context.actorId });
  });

  it("preserves Core validation details for failed content requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "At least one publishing channel is required", code: "bad_request" }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).createContentDraft(context, { content: "Draft", channels: ["bluesky"] }))
      .rejects.toMatchObject({ code: "CORE_REQUEST_FAILED", message: "kasitek-core returned 400: At least one publishing channel is required" });
  });

  it("routes publishing through the approval-bound core capability", async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ post: { id: "post-1", content: "Hello", channels: ["threads"], status: "PUBLISHED" }, result: { status: "sent" } }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
    });
    await expect(new KasitekCoreReadClient(config).publishContentPost(context, "post-1", "THREADS")).resolves.toMatchObject({ post: { status: "PUBLISHED" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/posts/post-1/publish");
    expect(init.headers).toHaveProperty("idempotency-key");
    expect(JSON.parse(String(init.body))).toEqual({ platform: "THREADS" });
  });

  it("routes scheduling through the durable content capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ post: { id: "post-1", content: "Hello", channels: ["threads"], status: "SCHEDULED" }, status: "SCHEDULED" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    await expect(new KasitekCoreReadClient(config).scheduleContentPost(context, "post-1", "2030-01-01T12:00:00.000Z")).resolves.toMatchObject({ status: "SCHEDULED" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://core.example.test/api/internal/agents/v1/content/posts/post-1/schedule");
    expect(init.headers).toHaveProperty("idempotency-key");
    expect(JSON.parse(String(init.body))).toEqual({ scheduledFor: "2030-01-01T12:00:00.000Z" });
  });

  it("routes unscheduling and unpublished deletion through idempotent content actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ post: { id: "post-1", status: "DRAFT" }, status: "DRAFT" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ postId: "post-1", deleted: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ AGENTS_DATABASE_URL: "postgres://localhost/agents", KASITEK_CORE_URL: "https://core.example.test", KASITEK_CORE_INTERNAL_TOKEN: "internal-token" });
    const client = new KasitekCoreReadClient(config);
    await expect(client.unscheduleContentPost(context, "post-1")).resolves.toMatchObject({ status: "DRAFT" });
    await expect(client.deleteContentPost(context, "post-1")).resolves.toEqual({ postId: "post-1", deleted: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/content/posts/post-1/unschedule");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toHaveProperty("idempotency-key");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/content/posts/post-1");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("DELETE");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).toHaveProperty("idempotency-key");
  });

  it("binds a delegation token to the installation and the exact core capability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ customer: { id: "cust-1" }, identities: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { privateKey } = await import("node:crypto").then(({ generateKeyPairSync }) => generateKeyPairSync("ec", { namedCurve: "prime256v1" }));
    const config = loadConfig({
      AGENTS_DATABASE_URL: "postgres://localhost/agents",
      KASITEK_CORE_URL: "https://core.example.test",
      KASITEK_CORE_DELEGATION_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      KASITEK_CORE_DELEGATION_KEY_ID: "delegation-2026-08",
    });
    await new KasitekCoreReadClient(config).getCustomer(context, "cust-1");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const token = String((request.headers as Record<string, string>).authorization).slice("Bearer ".length);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.sub).toBe("install-1");
    expect(claims.capability).toBe("kasitek.core.customer_get");
    const header = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
    expect(header.kid).toBe("delegation-2026-08");
  });
});
