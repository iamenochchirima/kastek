import {
  parseGrowthChannelAdminRequest,
  parseGrowthChannelAdminResponse,
  type GrowthChannelAdminRequest,
  type GrowthChannelAdminResponse,
} from "@kasitek-labs/contracts";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { outboundTraceHeaders } from "../observability/context.js";
import { providerSpan } from "../observability/operations.js";
import { growthAgentApiUrl, signGrowthAgentCommand } from "./security.js";

const PATH = "/internal/v1/products/growth/channels";

export function channelFailure(status: number, text: string): ApiError {
  if (Buffer.byteLength(text) > 16_384)
    return new ApiError(502, "agent_channel_response_invalid", "Agents returned an invalid channel result");
  let code: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    code =
      parsed && typeof parsed === "object" && "error" in parsed && parsed.error && typeof parsed.error === "object"
        ? (parsed.error as { code?: unknown }).code
        : undefined;
  } catch {
    code = undefined;
  }
  if (code === "TELEGRAM_BOT_ALREADY_CONNECTED")
    return new ApiError(409, "telegram_bot_already_connected", "This Telegram bot is already connected. Manage the existing connection.");
  if (code === "CHANNEL_CONNECTION_CHANGED")
    return new ApiError(409, "agent_channel_conflict", "The connection changed. Refresh and try again.");
  if (code === "PRODUCT_REQUEST_CONFLICT" || code === "PRODUCT_REQUEST_IN_PROGRESS")
    return new ApiError(409, "agent_channel_conflict", "This channel request is already being processed.");
  if (code === "GROWTH_CHANNEL_ORGANIZATION_UNAVAILABLE")
    return new ApiError(404, "agent_channel_not_found", "Agent channels are not configured for this workspace.");
  if (code === "GROWTH_ASSISTANT_UNAVAILABLE")
    return new ApiError(409, "assistant_target_unavailable", "The Growth assistant is not provisioned for this workspace.");
  if (code === "CHANNEL_SETUP_NOT_CONFIGURED")
    return new ApiError(503, "agent_channel_unavailable", "Telegram setup is unavailable.");
  const permanent = [400, 401, 403, 404, 409, 422].includes(status);
  return new ApiError(
    permanent ? 403 : 503,
    permanent ? "agent_channel_denied" : "agent_channel_unavailable",
    "Agents could not complete the channel request",
  );
}

export async function requestGrowthChannelAdmin(
  config: CoreConfig,
  request: GrowthChannelAdminRequest,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GrowthChannelAdminResponse> {
  let body: GrowthChannelAdminRequest;
  try {
    body = parseGrowthChannelAdminRequest(request);
  } catch {
    throw new ApiError(
      400,
      "agent_channel_request_invalid",
      "Channel request is invalid",
    );
  }
  const base = growthAgentApiUrl(config);
  if (!base)
    throw new ApiError(
      503,
      "agent_channel_unavailable",
      "Agents is not configured",
    );
  const token = await signGrowthAgentCommand(config, body);
  const response = await providerSpan("kasitek-agents", "channel-admin", () =>
    (options.fetch ?? fetch)(base + PATH, {
      method: "POST",
      redirect: "error",
      headers: {
        ...outboundTraceHeaders(),
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-correlation-id": body.requestId,
      },
      body: JSON.stringify(body),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    }),
  );
  const text = await response.text();
  if (!response.ok) throw channelFailure(response.status, text);
  if (Buffer.byteLength(text) > 131072)
    throw new ApiError(
      502,
      "agent_channel_response_invalid",
      "Agents returned an invalid channel result",
    );
  let result: GrowthChannelAdminResponse;
  try {
    result = parseGrowthChannelAdminResponse(JSON.parse(text));
  } catch {
    throw new ApiError(
      502,
      "agent_channel_response_invalid",
      "Agents returned an invalid channel result",
    );
  }
  if (
    result.requestId !== body.requestId ||
    result.operation !== body.operation
  )
    throw new ApiError(
      502,
      "agent_channel_response_invalid",
      "Agents returned an invalid channel result",
    );
  return result;
}
