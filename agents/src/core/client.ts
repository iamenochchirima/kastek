import type { AppConfig } from "../config";
import type { ToolInvocationContext } from "../tools/types";

export interface CoreCustomerDetail {
  customer: {
    id: string;
    displayName?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt?: string;
    updatedAt?: string;
  };
  identities: unknown[];
  contacts: unknown[];
  conversations: unknown[];
  bookings: unknown[];
  agentEvents: unknown[];
}

export class CoreToolError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CoreToolError";
  }
}

/**
 * Narrow, authenticated client for read-only kasitek-core operations.
 * The core service remains the authority for tenant data and enforces the
 * organization scope from the request headers; this service never connects
 * to the core database directly.
 */
export class KasitekCoreReadClient {
  public constructor(private readonly config: AppConfig) {}

  public async getCustomer(
    context: ToolInvocationContext,
    customerId: string,
  ): Promise<CoreCustomerDetail> {
    const baseUrl = this.config.KASITEK_CORE_URL?.replace(/\/$/, "");
    const token = this.config.KASITEK_CORE_INTERNAL_TOKEN?.trim();
    if (!baseUrl || !token) {
      throw new CoreToolError("CORE_UNAVAILABLE", "kasitek-core read boundary is not configured");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.KASITEK_CORE_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/api/internal/agents/v1/customers/${encodeURIComponent(customerId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "x-organization-id": context.organizationId,
          "x-actor-id": context.actorId ?? "kasitek-agent-platform",
          "x-agent-run-id": context.runId,
          "x-correlation-id": context.correlationId,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        if (response.status === 404) throw new CoreToolError("CORE_NOT_FOUND", "Customer not found");
        if (response.status === 401 || response.status === 403) throw new CoreToolError("CORE_UNAUTHORIZED", "kasitek-core rejected the agent credential");
        throw new CoreToolError("CORE_REQUEST_FAILED", `kasitek-core returned ${response.status}${body ? `: ${body.slice(0, 240)}` : ""}`);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("customer" in payload)) {
        throw new CoreToolError("CORE_INVALID_RESPONSE", "kasitek-core returned an invalid customer response");
      }
      return payload as CoreCustomerDetail;
    } catch (error) {
      if (error instanceof CoreToolError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new CoreToolError("CORE_TIMEOUT", "kasitek-core read timed out");
      }
      throw new CoreToolError("CORE_REQUEST_FAILED", error instanceof Error ? error.message : "kasitek-core request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
