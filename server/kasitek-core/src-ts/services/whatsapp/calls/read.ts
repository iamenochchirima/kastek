import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { SQL } from './sql.js';
import { missing, json, callView, eventView, type CallRow } from './types.js';
export async function scopedCall(
  pool: Pool,
  org: string,
  id: string,
): Promise<CallRow> {
  return (
    (await pool.query(SQL.scoped_call_row![0]!, [id, org])).rows[0] ??
    missing('Call session not found')
  );
}
export async function existingCall(
  pool: Pool,
  waId: string,
): Promise<CallRow | null> {
  return (
    (await pool.query(SQL.call_row_by_wa_call_id![0]!, [waId])).rows[0] ?? null
  );
}
export async function appendCallEvent(
  pool: Pool,
  id: string,
  type: string,
  status: string | null,
  payload: unknown,
) {
  await pool.query(SQL.append_call_event![0]!, [
    createId(),
    id,
    type,
    status,
    json(payload),
  ]);
}
export async function listCalls(pool: Pool, org: string) {
  return {
    calls: (await pool.query(SQL.list_call_rows![0]!, [org])).rows.map(
      callView,
    ),
  };
}
export async function getCall(pool: Pool, org: string, id: string) {
  const call = await scopedCall(pool, org, id);
  return {
    call: callView(call),
    events: (await pool.query(SQL.call_event_rows![0]!, [id])).rows.map(
      eventView,
    ),
  };
}
export async function listCallSignals(pool: Pool, org: string, id: string) {
  const call = await scopedCall(pool, org, id);
  return {
    call: callView(call),
    signals: (await pool.query(SQL.call_signal_rows![0]!, [id])).rows.map(
      eventView,
    ),
  };
}
export async function callSummary(
  pool: Pool,
  org: string,
  days: number | bigint,
) {
  days = Number(days < 1 ? 1 : days > 90 ? 90 : days);
  const params = [org, `${days} days`],
    totals = (await pool.query(SQL.call_summary![0]!, params)).rows[0]!,
    trend = (await pool.query(SQL.call_summary![1]!, params)).rows.map((r) => ({
      day: r.day,
      total: BigInt(r.total),
      inbound: BigInt(r.inbound),
      missed: BigInt(r.missed),
      completed: BigInt(r.completed),
    }));
  const fields: Record<string, string> = {
    totalCalls: 'total_calls',
    inboundCalls: 'inbound_calls',
    outboundCalls: 'outbound_calls',
    ringingCalls: 'ringing_calls',
    activeCalls: 'active_calls',
    completedCalls: 'completed_calls',
    missedCalls: 'missed_calls',
    failedCalls: 'failed_calls',
    rejectedCalls: 'rejected_calls',
    recentCalls: 'recent_calls',
  };
  return {
    days,
    summary: Object.fromEntries(
      Object.entries(fields).map(([key, column]) => [
        key,
        BigInt(totals[column]),
      ]),
    ),
    trend,
  };
}
