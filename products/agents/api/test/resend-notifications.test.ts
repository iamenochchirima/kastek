import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ResendNotificationSender } from "../src/adapters/notifications/resend";
import { customerReturnUrl } from "../src/product/customer-followup/return-url";

describe("transactional notification sender", () => {
  let server: Server, base: string, mode = "ok", requests: Array<{ headers: import("node:http").IncomingHttpHeaders; body: unknown }> = [];
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let body = ""; for await (const part of request) body += part;
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      if (mode === "lost") return request.socket.destroy();
      response.setHeader("content-type", "application/json");
      response.statusCode = mode === "rejected" ? 422 : mode === "rate" ? 429 : 200;
      response.end(mode === "ok" ? JSON.stringify({ id: "provider-receipt" }) : "{}");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(() => { requests = []; mode = "ok"; });
  const message = { to: "customer@example.test", subject: "Support replied", text: "Open your conversation.", idempotencyKey: "notification_1" };
  const sender = () => new ResendNotificationSender("fixture-key", "support@example.test", { testBaseUrl: base, timeoutMs: 5000 });
  it("records acceptance separately from delivery and sends one bounded request", async () => {
    expect(await sender().send(message)).toEqual({ state: "accepted", providerId: "provider-receipt" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["idempotency-key"]).toBe("notification_1");
    expect(requests[0]?.body).toEqual({ from: "support@example.test", to: [message.to], subject: message.subject, text: message.text });
  });
  it("does not retry unknown delivery outcomes", async () => {
    mode = "lost"; expect(await sender().send(message)).toEqual({ state: "unknown" }); expect(requests).toHaveLength(1);
    mode = "rate"; expect(await sender().send(message)).toEqual({ state: "unknown" }); expect(requests).toHaveLength(2);
  });
  it("returns a definite rejection without including private provider output", async () => {
    mode = "rejected"; expect(await sender().send(message)).toEqual({ state: "rejected", status: 422 });
  });
  it("rejects malformed addresses before sending", async () => {
    await expect(sender().send({ ...message, to: "bad\r\naddress" })).rejects.toThrow(); expect(requests).toHaveLength(0);
  });
  it("rechecks authority before the physical request", async () => {
    expect(await sender().send(message, async () => { throw new Error("revoked"); })).toEqual({state:"unknown"});
    expect(requests).toHaveLength(0);
  });
  it("keeps a one-time return challenge in the fragment on the configured first-party origin", () => {
    const url = new URL(customerReturnUrl("https://agents.example/", "11111111-1111-4111-8111-111111111111", "A".repeat(43)));
    expect(url.origin).toBe("https://agents.example"); expect(url.search).toBe(""); expect(url.hash).toBe(`#${"A".repeat(43)}`);
    expect(() => customerReturnUrl("http://public.example/", "11111111-1111-4111-8111-111111111111", "A".repeat(43))).toThrow();
  });
});
