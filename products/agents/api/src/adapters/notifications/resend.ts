import { z } from "zod";
import { createBoundedFetch } from "../../infrastructure/connected-network";

const mailAddress = z.email().max(254);
const messageSchema = z.strictObject({
  to: mailAddress,
  subject: z.string().trim().min(1).max(160).refine(value => !/[\r\n]/.test(value)),
  text: z.string().min(1).max(16000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export type NotificationMessage = z.infer<typeof messageSchema>;
export type NotificationResult = { state: "accepted"; providerId: string } | { state: "rejected"; status: number } | { state: "unknown" };

/** A single provider acceptance is not proof of delivery. Call only after a durable send claim. */
export class ResendNotificationSender {
  private readonly endpoint: string;
  constructor(private readonly apiKey: string, private readonly sender: string, private readonly options: { timeoutMs: number; testBaseUrl?: string }) {
    if (!apiKey || apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(apiKey)) throw new Error("Invalid email provider credentials");
    const address = sender.match(/<([^<>]+)>$/)?.[1]?.trim() ?? sender;
    mailAddress.parse(address);
    z.number().int().min(1).max(30000).parse(options.timeoutMs);
    const base = options.testBaseUrl ? new URL(options.testBaseUrl) : new URL("https://api.resend.com");
    if (options.testBaseUrl && (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password || base.search || base.hash || base.pathname !== "/")) throw new Error("Invalid email test endpoint");
    this.endpoint = new URL("/emails", base).href;
  }
  async send(input: NotificationMessage, beforeAttempt?: () => Promise<void>): Promise<NotificationResult> {
    const message = messageSchema.parse(input);
    const fetcher = createBoundedFetch({ authorizeUrl: url => url.href === this.endpoint, headers: { authorization: `Bearer ${this.apiKey}`, "idempotency-key": message.idempotencyKey },
      maxRequestBytes: 32768, maxResponseBytes: 16384, deadlineAt: Date.now() + this.options.timeoutMs, maxAttempts: 1, maxRequests: 1,
      testLoopback: Boolean(this.options.testBaseUrl), returnProviderErrorResponses: true, beforeAttempt });
    try {
      const response = await fetcher(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: this.sender, to: [message.to], subject: message.subject, text: message.text }) });
      const body = await response.text();
      if (body.includes(this.apiKey)) return { state: "unknown" };
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409 && response.status !== 429) return { state: "rejected", status: response.status };
      if (response.status !== 200) return { state: "unknown" };
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return { state: "unknown" }; }
      const receipt = z.object({ id: z.string().min(1).max(256) }).safeParse(payload);
      return receipt.success ? { state: "accepted", providerId: receipt.data.id } : { state: "unknown" };
    } catch { return { state: "unknown" }; }
  }
}
