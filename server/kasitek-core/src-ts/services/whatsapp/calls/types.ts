import { SerdeFloat } from "@kasitek-labs/server-support/json";
import type { CoreConfig } from "../../../config.js";
import type { Pool } from "pg";
import { ApiError } from "../../../error.js";
import { apiJson } from "../../../json.js";
import { publishWhatsappEvent } from "../../realtime.js";
import {
  sendPushNotificationToUser,
  type PushNotificationPayload,
} from "../../notifications.js";
import type { NotificationLogger } from "../../notifications.js";
export type Row = Record<string, unknown>;
export interface CallRow extends Row {
  id: string;
  user_id: string;
  connection_id: string;
  conversation_id: string | null;
  direction: string;
  status: string;
  wa_call_id: string | null;
  from_phone: string;
  to_phone: string;
  raw_payload: unknown;
  started_at: Date | null;
  answered_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
}
export interface CallsOptions {
  fetch?: typeof fetch;
  graphBase?: string;
  publishEvent?: (org: string, event: unknown) => Promise<void>;
  sendPush?: (
    user: string,
    payload: PushNotificationPayload,
  ) => Promise<unknown>;
  logger?: NotificationLogger;
}
export const object = (value: unknown): Row =>
  value !== null &&
  typeof value === "object" &&
  !(value instanceof SerdeFloat) &&
  !Array.isArray(value)
    ? (value as Row)
    : {};
export const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
export function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}
export function missing(message: string): never {
  throw new ApiError(404, "not_found", message);
}
export function internal(message: string): never {
  throw new ApiError(500, "internal_error", message);
}
export const json = apiJson;
const callFields: Record<string, string> = {
  id: "id",
  user_id: "user_id",
  connectionId: "connection_id",
  conversationId: "conversation_id",
  direction: "direction",
  status: "status",
  waCallId: "wa_call_id",
  fromPhone: "from_phone",
  toPhone: "to_phone",
  agentLabel: "agent_label",
  startedAt: "started_at",
  answeredAt: "answered_at",
  endedAt: "ended_at",
  durationSeconds: "duration_seconds",
  errorCode: "error_code",
  errorMessage: "error_message",
  rawPayload: "raw_payload",
  conversationCustomerName: "conversation_customer_name",
  connectionLabel: "connection_label",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
export const callView = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(callFields).map(([key, column]) => [
      key,
      row[column] ?? null,
    ]),
  );
export const eventView = (row: Row): Row => ({
  id: row.id,
  sessionId: row.session_id,
  eventType: row.event_type,
  status: row.status ?? null,
  payload: row.payload ?? null,
  createdAt: row.created_at,
});
export async function publish(
  pool: Pool,
  config: CoreConfig,
  org: string,
  event: unknown,
  options: CallsOptions,
) {
  try {
    await (
      options.publishEvent ??
      ((org, event) =>
        publishWhatsappEvent({ pool, config }, org, event, options.logger))
    )(org, event);
  } catch {
    options.logger?.warn(
      {
        event: "operation.failed",
        operation: "whatsapp_call.realtime_publish",
      },
      "WhatsApp call realtime event publish failed",
    );
  }
}
export async function push(
  pool: Pool,
  config: CoreConfig,
  user: string,
  payload: PushNotificationPayload,
  options: CallsOptions,
) {
  try {
    await (
      options.sendPush ??
      ((user, payload) =>
        sendPushNotificationToUser(
          { pool, config },
          user,
          payload,
          options.logger,
        ))
    )(user, payload);
  } catch {
    options.logger?.warn(
      {
        event: "operation.failed",
        operation: "push_notification.send",
        provider: "whatsapp",
        user_id: user,
      },
      "push notification for incoming WhatsApp call failed",
    );
  }
}
