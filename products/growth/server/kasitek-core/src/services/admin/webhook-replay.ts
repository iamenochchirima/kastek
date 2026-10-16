import type { Pool, PoolClient } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import * as sql from './webhook_replay-sql.js';
import {
  bad,
  missing,
  conflict,
  byteLength,
  requireString,
  transaction,
  json,
  type ObjectValue,
} from './common.js';
const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const view = (row: ObjectValue) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camel(key), value]),
  );
export function validateReplayKey(value: string) {
  const key = value.trim();
  if (byteLength(key) < 8 || byteLength(key) > 240)
    bad('idempotency-key must be 8-240 characters');
  return key;
}
export function validateReplay(input: ObjectValue) {
  const deliveryId = requireString(input, 'deliveryId').trim(),
    expectedStatus = requireString(input, 'expectedStatus')
      .trim()
      .toUpperCase(),
    count = Number(input.expectedAttemptCount);
  if (
    typeof input.expectedAttemptCount !== 'number' ||
    !Number.isInteger(input.expectedAttemptCount) ||
    input.expectedAttemptCount < -(2 ** 31) ||
    input.expectedAttemptCount >= 2 ** 31
  )
    bad('Invalid request');
  if (!deliveryId || byteLength(deliveryId) > 160)
    bad('deliveryId must be between 1 and 160 characters');
  if (expectedStatus !== 'FAILED')
    bad('expectedStatus must be FAILED for a webhook replay');
  if (!Number.isInteger(count) || count < 0)
    bad('expectedAttemptCount must be zero or greater');
  return { deliveryId, expectedStatus, count };
}
async function audit(
  tx: PoolClient,
  id: string,
  actor: string,
  action: string,
  meta: ObjectValue,
) {
  await tx.query(sql.RECORD_AUDIT_0, [
    createId(),
    id,
    actor,
    action,
    json(meta),
  ]);
}
export async function failedDeliveries(pool: Pool, limit: number) {
  return (
    await pool.query(sql.LIST_FAILED_DELIVERIES_0, [
      Math.max(1, Math.min(100, limit)),
    ])
  ).rows.map(view);
}
export async function createReplay(
  pool: Pool,
  key: string,
  actor: string,
  input: ObjectValue,
) {
  key = validateReplayKey(key);
  const request = validateReplay(input),
    existing = (await pool.query(sql.LOAD_COMMAND_0, [key])).rows[0];
  if (existing) {
    if (
      existing.delivery_id !== request.deliveryId ||
      existing.expected_status !== request.expectedStatus ||
      existing.expected_attempt_count !== request.count
    )
      conflict(
        'idempotency key is already bound to a different replay request',
      );
    return view(existing);
  }
  return transaction(pool, async (tx) => {
    const delivery =
      (await tx.query(sql.CREATE_0, [request.deliveryId])).rows[0] ??
      missing('Webhook delivery not found');
    if (
      delivery.status !== request.expectedStatus ||
      delivery.attempt_count !== request.count
    )
      conflict('Webhook delivery changed; refresh the operator queue');
    if (delivery.subscription_status !== 'ACTIVE')
      conflict('Webhook subscription is not active');
    const command = (
      await tx.query(sql.CREATE_1, [
        createId(),
        key,
        request.deliveryId,
        actor,
        request.expectedStatus,
        request.count,
      ])
    ).rows[0];
    if (!command) conflict('Replay request was concurrently created');
    await audit(tx, command.id, actor, 'replay_requested', {
      deliveryId: delivery.id,
      expectedStatus: request.expectedStatus,
      expectedAttemptCount: request.count,
      eventType: delivery.event_type,
    });
    return view(command);
  });
}
export async function getReplay(pool: Pool, id: string) {
  return view(
    (await pool.query(sql.GET_0, [id.trim()])).rows[0] ??
      missing('Webhook replay command not found'),
  );
}
export async function approveReplay(pool: Pool, id: string, actor: string) {
  const commandId = await transaction(pool, async (tx) => {
    const command =
      (await tx.query(sql.APPROVE_0, [id.trim()])).rows[0] ??
      missing('Webhook replay command not found');
    if (command.status !== 'awaiting_approval') return command.id as string;
    const approvers = command.approver_ids as string[];
    if (approvers.includes(actor))
      conflict('A second, distinct operator approval is required');
    approvers.push(actor);
    if (approvers.length < 2) {
      await tx.query(sql.APPROVE_1, [command.id, approvers]);
      await audit(tx, command.id, actor, 'replay_approved', {
        approvalCount: approvers.length,
      });
      return command.id as string;
    }
    const delivery = (await tx.query(sql.APPROVE_2, [command.delivery_id]))
      .rows[0];
    const failure = !delivery
      ? 'Webhook delivery no longer exists'
      : delivery.status !== command.expected_status ||
          delivery.attempt_count !== command.expected_attempt_count ||
          delivery.subscription_status !== 'ACTIVE'
        ? 'Webhook delivery changed or its subscription is inactive'
        : null;
    if (failure) {
      await tx.query(sql.FAIL_COMMAND_0, [command.id, approvers, failure]);
      await audit(tx, command.id, actor, 'replay_rejected', {
        reason: failure,
      });
      return command.id as string;
    }
    await tx.query(sql.APPROVE_3, [
      command.delivery_id,
      command.expected_status,
      command.expected_attempt_count,
    ]);
    await tx.query(sql.APPROVE_4, [
      command.id,
      approvers,
      json({
        deliveryId: command.delivery_id,
        status: 'PENDING',
        attemptCount: 0,
        eventType: delivery!.event_type,
      }),
    ]);
    await audit(tx, command.id, actor, 'replay_queued', {
      deliveryId: command.delivery_id,
      previousStatus: command.expected_status,
      previousAttemptCount: command.expected_attempt_count,
    });
    return command.id as string;
  });
  return getReplay(pool, commandId);
}
