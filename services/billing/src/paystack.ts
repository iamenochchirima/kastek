import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, bad, jsonObject, optionalText, text } from "./util.js";

export interface VerifiedTransaction {
  successful: boolean;
  reference: string;
  amountMinor: bigint | null;
  currency: string | null;
  customerId: string | null;
  providerCustomerId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  providerAuthorizationId: string | null;
}

export interface VerifiedSubscription {
  subscriptionId: string;
  state: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  providerInvoiceId: string | null;
}

export type ProviderEvent =
  | {
      kind: "charge_succeeded";
      reference: string;
      customerId: string | null;
      subscriptionId: string | null;
      transactionId: string | null;
      invoiceId: string | null;
      amountMinor: bigint | null;
      currency: string | null;
    }
  | {
      kind: "subscription_created";
      subscriptionId: string;
      customerId: string;
      planCode: string;
    }
  | {
      kind:
        | "subscription_not_renewing"
        | "subscription_disabled"
        | "invoice_payment_failed";
      subscriptionId: string;
    }
  | {
      kind: "refund_processed";
      transactionReference: string;
      amountMinor: bigint | null;
    }
  | { kind: "dispute_opened"; transactionReference: string }
  | { kind: "ignored" };

export interface BillingProvider {
  readonly name: string;
  initializeCheckout(request: {
    email: string;
    planCode: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    callbackUrl: string;
    metadata: unknown;
  }): Promise<{ authorizationUrl: string; reference: string }>;
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  verifySubscription(subscriptionId: string): Promise<VerifiedSubscription>;
  resolveSubscriptionId(input: {
    providerCustomerId: string;
    planCode: string;
  }): Promise<string | null>;
  setSubscriptionEnabled(subscriptionId: string, enabled: boolean): Promise<void>;
  verifyWebhook(payload: Buffer, signature: string): boolean;
  parseWebhook(value: unknown): ProviderEvent;
}

function external(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  return null;
}

function i64(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function date(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function subscriptionCode(value: Record<string, unknown>): string | null {
  return (
    optionalText(value.subscription_code) ??
    optionalText(jsonObject(value.subscription).subscription_code)
  );
}

export function parseVerifiedTransaction(value: unknown): VerifiedTransaction {
  const data = jsonObject(value);
  const reference = optionalText(data.reference);
  if (!reference) bad("Paystack reference is missing");
  return {
    successful: data.status === "success",
    reference: reference!,
    amountMinor: i64(data.amount),
    currency: optionalText(data.currency)?.toUpperCase() ?? null,
    customerId: optionalText(jsonObject(data.customer).customer_code),
    providerCustomerId: external(jsonObject(data.customer).id),
    subscriptionId: subscriptionCode(data),
    providerTransactionId: external(data.id),
    providerAuthorizationId: external(
      jsonObject(data.authorization).authorization_code,
    ),
  };
}

export function parseVerifiedSubscription(value: unknown): VerifiedSubscription {
  const data = jsonObject(value);
  const id = subscriptionCode(data);
  if (!id) bad("Paystack subscription code is missing");
  const invoice = jsonObject(data.most_recent_invoice);
  return {
    subscriptionId: id!,
    state: optionalText(data.status) ?? "unknown",
    currentPeriodStart: date(invoice.period_start),
    currentPeriodEnd: date(invoice.period_end) ?? date(data.next_payment_date),
    providerInvoiceId: external(invoice.invoice_code) ?? external(invoice.id),
  };
}

export class PaystackProvider implements BillingProvider {
  readonly name = "paystack";

  constructor(
    private readonly secret: string,
    private readonly baseUrl = "https://api.paystack.co",
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(
    path: string,
    body?: unknown,
    allowEmpty = false,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.secret}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new HttpError(502, "Paystack request failed", "provider_unavailable");
    }
    let result: Record<string, unknown>;
    try {
      result = jsonObject(await response.json());
    } catch {
      throw new HttpError(502, "Invalid Paystack response", "provider_invalid");
    }
    if (
      !response.ok ||
      result.status !== true ||
      (!allowEmpty && result.data == null)
    )
      bad(optionalText(result.message) ?? "Paystack request failed");
    return result.data;
  }

  async initializeCheckout(request: {
    email: string;
    planCode: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    callbackUrl: string;
    metadata: unknown;
  }): Promise<{ authorizationUrl: string; reference: string }> {
    if (request.amountMinor > BigInt(Number.MAX_SAFE_INTEGER))
      throw new HttpError(400, "Checkout amount is too large", "bad_request");
    const data = jsonObject(
      await this.request("/transaction/initialize", {
        email: request.email,
        amount: Number(request.amountMinor),
        currency: request.currency,
        plan: request.planCode,
        reference: request.reference,
        callback_url: request.callbackUrl,
        metadata: request.metadata,
      }),
    );
    const authorizationUrl = optionalText(data.authorization_url);
    const reference = optionalText(data.reference);
    if (!authorizationUrl || !reference)
      throw new HttpError(
        502,
        "Invalid Paystack checkout response",
        "provider_invalid",
      );
    return { authorizationUrl, reference };
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    return parseVerifiedTransaction(
      await this.request(`/transaction/verify/${encodeURIComponent(reference)}`),
    );
  }

  async verifySubscription(subscriptionId: string): Promise<VerifiedSubscription> {
    return parseVerifiedSubscription(
      await this.request(`/subscription/${encodeURIComponent(subscriptionId)}`),
    );
  }

  async resolveSubscriptionId(input: {
    providerCustomerId: string;
    planCode: string;
  }): Promise<string | null> {
    const data = await this.request(
      `/subscription?customer=${encodeURIComponent(input.providerCustomerId)}&perPage=100`,
    );
    if (!Array.isArray(data)) return null;
    let fallback: string | null = null;
    for (const row of data) {
      const value = jsonObject(row);
      const code = subscriptionCode(value);
      const planCode = optionalText(jsonObject(value.plan).plan_code);
      if (!code || planCode !== input.planCode) continue;
      if (optionalText(value.status) === "active") return code;
      fallback ??= code;
    }
    return fallback;
  }

  async setSubscriptionEnabled(
    subscriptionId: string,
    enabled: boolean,
  ): Promise<void> {
    const data = jsonObject(
      await this.request(`/subscription/${encodeURIComponent(subscriptionId)}`),
    );
    const token = optionalText(data.email_token);
    if (!token) bad("Paystack subscription management token is missing");
    await this.request(
      `/subscription/${enabled ? "enable" : "disable"}`,
      { code: subscriptionId, token },
      true,
    );
  }

  verifyWebhook(payload: Buffer, signature: string): boolean {
    const hex = signature.trim();
    if (!/^[a-f0-9]{128}$/i.test(hex)) return false;
    const expected = createHmac("sha512", this.secret).update(payload).digest();
    const actual = Buffer.from(hex, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  parseWebhook(value: unknown): ProviderEvent {
    const event = jsonObject(value);
    const kind = optionalText(event.event);
    if (!kind) bad("Paystack event type is missing");
    if (!("data" in event)) bad("Paystack webhook data is missing");
    const data = jsonObject(event.data);
    const subscription = subscriptionCode(data);
    const transaction =
      optionalText(data.transaction_reference) ??
      optionalText(jsonObject(data.transaction).reference);
    const requiredSubscription = () =>
      subscription ?? bad("Paystack subscription code is missing");

    switch (kind) {
      case "charge.success":
        if (data.status !== "success") return { kind: "ignored" };
        return {
          kind: "charge_succeeded",
          reference: optionalText(data.reference) ?? bad("Paystack reference is missing"),
          customerId: optionalText(jsonObject(data.customer).customer_code),
          subscriptionId: subscription,
          transactionId: external(data.id),
          invoiceId:
            external(data.invoice_code) ??
            external(jsonObject(data.invoice).invoice_code),
          amountMinor: i64(data.amount),
          currency: optionalText(data.currency)?.toUpperCase() ?? null,
        };
      case "subscription.create":
        return {
          kind: "subscription_created",
          subscriptionId: requiredSubscription(),
          customerId:
            optionalText(jsonObject(data.customer).customer_code) ??
            bad("Paystack customer code is missing"),
          planCode:
            optionalText(jsonObject(data.plan).plan_code) ??
            bad("Paystack plan code is missing"),
        };
      case "subscription.not_renew":
        return {
          kind: "subscription_not_renewing",
          subscriptionId: requiredSubscription(),
        };
      case "subscription.disable":
        return {
          kind: "subscription_disabled",
          subscriptionId: requiredSubscription(),
        };
      case "invoice.payment_failed":
        return {
          kind: "invoice_payment_failed",
          subscriptionId: requiredSubscription(),
        };
      case "refund.processed":
        return {
          kind: "refund_processed",
          transactionReference:
            transaction ?? bad("Paystack refund transaction reference is missing"),
          amountMinor: i64(data.amount),
        };
      case "charge.dispute.create":
        return {
          kind: "dispute_opened",
          transactionReference:
            transaction ?? bad("Paystack dispute transaction reference is missing"),
        };
      default:
        return { kind: "ignored" };
    }
  }
}

export function paystackEventKey(value: unknown): string {
  const event = jsonObject(value);
  const kind = optionalText(event.event) ?? bad("Paystack event type is missing");
  const data = jsonObject(event.data);
  const identity =
    "id" in data
      ? JSON.stringify(data.id)
      : (optionalText(data.reference) ??
        optionalText(data.subscription_code) ??
        createHash("sha512").update(JSON.stringify(value)).digest("hex"));
  return `${kind}:${identity}`;
}

export function providerFromConfig(config: {
  paystack: { secret: string; baseUrl: string } | null;
}): BillingProvider {
  if (!config.paystack)
    throw new HttpError(503, "Paystack is not configured", "provider_unavailable");
  return new PaystackProvider(config.paystack.secret, config.paystack.baseUrl);
}

export function internalSubscriptionState(
  state: string,
): "trialing" | "active" | "past_due" | "canceled" | null {
  switch (state) {
    case "active":
      return "active";
    case "non-renewing":
      return "active";
    case "attention":
      return "past_due";
    case "completed":
    case "cancelled":
      return "canceled";
    default:
      return null;
  }
}
