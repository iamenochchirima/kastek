import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import * as sql from './outreach-sql.js';
import { rowView } from './rows.js';
import {
  bad,
  missing,
  present,
  requireString,
  nullableDate,
  transaction,
  updateFields,
  type ObjectValue,
} from './common.js';
const expand = (text: string) =>
  text
    .replaceAll('{CAMPAIGN_COLS}', sql.CAMPAIGN_COLS)
    .replaceAll('{LEAD_COLS}', sql.LEAD_COLS);
const campaignView = (r: ObjectValue) => rowView('outreach.CampaignRow', r),
  leadView = (r: ObjectValue) => rowView('outreach.LeadRow', r);
export async function listCampaigns(pool: Pool) {
  return (await pool.query(expand(sql.LIST_CAMPAIGNS_0))).rows.map(
    campaignView,
  );
}
export async function getCampaign(pool: Pool, id: string) {
  return campaignView(
    (await pool.query(expand(sql.GET_CAMPAIGN_0), [id])).rows[0] ??
      missing('campaign not found'),
  );
}
export async function createCampaign(pool: Pool, input: ObjectValue) {
  const id = createId(),
    time = new Date();
  await pool.query(sql.CREATE_CAMPAIGN_0, [
    id,
    requireString(input, 'name'),
    requireString(input, 'category'),
    input.status ?? 'draft',
    time,
    time,
  ]);
  return getCampaign(pool, id);
}
export async function updateCampaign(
  pool: Pool,
  id: string,
  input: ObjectValue,
) {
  return campaignView(
    await updateFields(
      pool,
      'OutreachCampaign',
      id,
      sql.CAMPAIGN_COLS,
      ['name', 'category', 'status'].map((k) => [
        k,
        present(input[k]) ? input[k] : undefined,
      ]),
      'campaign not found',
    ),
  );
}
export async function deleteCampaign(pool: Pool, id: string) {
  if (!(await pool.query(sql.DELETE_CAMPAIGN_0, [id])).rows.length)
    missing('campaign not found');
  return { deleted: true };
}
export async function deleteAllCampaigns(pool: Pool) {
  await pool.query(sql.DELETE_ALL_CAMPAIGNS_0);
  return {
    deleted: BigInt(
      (await pool.query(sql.DELETE_ALL_CAMPAIGNS_1)).rows[0]!.count,
    ),
  };
}
export async function listOutreachLeads(
  pool: Pool,
  campaignId: string,
  query: ObjectValue,
) {
  return (await pool.query(expand(sql.LIST_LEADS_0), [campaignId])).rows
    .filter(
      (r) =>
        (query.emailStatus == null || r.emailStatus === query.emailStatus) &&
        (query.search == null ||
          ['businessName', 'website', 'emailAddress'].some((k) =>
            String(r[k] ?? '')
              .toLowerCase()
              .includes(String(query.search).toLowerCase()),
          )),
    )
    .map(leadView);
}
export async function getOutreachLead(
  pool: Pool,
  campaignId: string,
  id: string,
) {
  return leadView(
    (await pool.query(expand(sql.GET_LEAD_0), [id, campaignId])).rows[0] ??
      missing('lead not found'),
  );
}
export async function createOutreachLead(
  pool: Pool,
  campaignId: string,
  input: ObjectValue,
) {
  if (!(await pool.query(sql.CREATE_LEAD_0, [campaignId])).rows.length)
    missing('campaign not found');
  const id = createId(),
    time = new Date();
  await pool.query(sql.CREATE_LEAD_1, [
    id,
    campaignId,
    requireString(input, 'businessName'),
    input.website ?? null,
    input.address ?? null,
    input.bizbayUrl ?? null,
    requireString(input, 'category'),
    input.phone ?? null,
    input.emailAddress ?? null,
    input.emailTemplate ?? null,
    input.notes ?? null,
    time,
    time,
  ]);
  await pool.query(sql.CREATE_LEAD_2, [campaignId]);
  return getOutreachLead(pool, campaignId, id);
}
export async function updateOutreachLead(
  pool: Pool,
  campaignId: string,
  id: string,
  input: ObjectValue,
) {
  const sets = ['"updatedAt"=$1'],
    args: unknown[] = [new Date()];
  for (const key of [
    'emailStatus',
    'phone',
    'emailAddress',
    'emailSentAt',
    'emailTemplate',
    'followUpCount',
    'lastFollowUp',
    'nextFollowUp',
    'notes',
  ]) {
    if (!present(input[key])) continue;
    args.push(
      ['emailSentAt', 'lastFollowUp', 'nextFollowUp'].includes(key)
        ? typeof input[key] === 'string'
          ? nullableDate(input[key] as string)
          : null
        : input[key],
    );
    sets.push(`"${key}"=$${args.length}`);
  }
  args.push(id, campaignId);
  const lead =
    (
      await pool.query(
        `UPDATE "OutreachLead" SET ${sets.join(',')} WHERE id=$${args.length - 1} AND "campaignId"=$${args.length} RETURNING ${sql.LEAD_COLS}`,
        args,
      )
    ).rows[0] ?? missing('lead not found');
  const [sent, replies] = await Promise.all([
    pool.query(sql.UPDATE_LEAD_1, [campaignId]),
    pool.query(sql.UPDATE_LEAD_2, [campaignId]),
  ]);
  await pool.query(sql.UPDATE_LEAD_3, [
    Number(BigInt.asIntN(32, BigInt(sent.rows[0]!.count))),
    Number(BigInt.asIntN(32, BigInt(replies.rows[0]!.count))),
    campaignId,
  ]);
  return leadView(lead);
}
export async function deleteOutreachLead(
  pool: Pool,
  campaignId: string,
  id: string,
) {
  if (!(await pool.query(sql.DELETE_LEAD_0, [id, campaignId])).rows.length)
    missing('lead not found');
  await pool.query(sql.DELETE_LEAD_1, [campaignId]);
  return { deleted: true };
}
export function bizbaySlug(name: string) {
  return [...name]
    .map((c) =>
      /[\p{Alphabetic}\p{Number}-]/u.test(c) ? c : c === ' ' ? '-' : '',
    )
    .join('')
    .toLowerCase();
}
export async function importCampaign(pool: Pool, input: ObjectValue) {
  const category = requireString(input, 'category'),
    name = requireString(input, 'name'),
    existing = (await pool.query(sql.IMPORT_CAMPAIGN_0, [category])).rows[0];
  if (existing)
    bad(`A campaign for "${category}" already exists: "${existing.name}"`);
  const listings = input.listings as ObjectValue[],
    id = createId(),
    time = new Date();
  await transaction(pool, async (tx) => {
    await tx.query(sql.IMPORT_CAMPAIGN_1, [
      id,
      name,
      category,
      listings.length,
      time,
      time,
    ]);
    for (const row of listings) {
      const businessName = requireString(row, 'name');
      await tx.query(sql.IMPORT_CAMPAIGN_2, [
        createId(),
        id,
        businessName,
        row.website ?? null,
        row.address ?? null,
        row.bizbayUrl ??
          `https://bizbay.co.za/Company/${bizbaySlug(businessName)}`,
        category,
        row.phone ?? null,
        time,
        time,
      ]);
    }
  });
  return getCampaign(pool, id);
}
export async function createDeliveryLogs(pool: Pool, logs: ObjectValue[]) {
  const time = new Date();
  for (const log of logs)
    await pool.query(sql.CREATE_DELIVERY_LOGS_0, [
      createId(),
      log.campaignId ?? null,
      log.leadId ?? null,
      requireString(log, 'recipient'),
      requireString(log, 'subject'),
      requireString(log, 'status'),
      requireString(log, 'provider'),
      log.providerMessageId ?? null,
      log.providerResponse ?? null,
      log.errorMessage ?? null,
      time,
    ]);
  return { created: logs.length };
}
export function csvCell(value: unknown) {
  const s = String(value ?? '');
  return /[,"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
export async function listDeliveryLogs(pool: Pool, query: ObjectValue) {
  const conditions: string[] = [],
    args: unknown[] = [];
  const add = (condition: string, value: unknown) => {
    args.push(value);
    conditions.push(condition.replace('?', `$${args.length}`));
  };
  for (const [key, column] of [
    ['campaignId', 'l."campaignId"'],
    ['status', 'l.status'],
  ] as const)
    if (typeof query[key] === 'string' && query[key])
      add(`${column}=?`, query[key]);
  if (query.mode === 'test') add('c.category=?', 'system-test');
  if (query.mode === 'live')
    add('(c.category IS NULL OR c.category!=?)', 'system-test');
  if (typeof query.recipient === 'string' && query.recipient)
    add('lower(l.recipient) LIKE ?', `%${query.recipient.toLowerCase()}%`);
  if (typeof query.domain === 'string') {
    const domain = query.domain.replace(/^@+/, '');
    if (domain) add('lower(l.recipient) LIKE ?', `%@${domain.toLowerCase()}`);
  }
  for (const [key, operator, time] of [
    ['dateFrom', '>=', '00:00:00'],
    ['dateTo', '<=', '23:59:59'],
  ] as const)
    if (typeof query[key] === 'string' && query[key])
      add(
        `l."attemptedAt" ${operator} ?::timestamptz`,
        `${query[key]}T${time}Z`,
      );
  args.push(Math.min(20000, Number(query.limit ?? 20000)));
  const rows = (
    await pool.query(
      sql.LIST_DELIVERY_LOGS_0.replace(
        '{where_clause}',
        conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      ).replace('{limit}', `$${args.length}`),
      args,
    )
  ).rows;
  if (query.format === 'csv')
    return (
      'attempted_at,status,recipient,subject,campaign,category,business,website,provider,error\n' +
      rows
        .map(
          (r) =>
            [
              r.attemptedAt.toJSON().replace(/Z$/, '+00:00'),
              r.status,
              r.recipient,
              r.subject,
              r.campaign_name,
              r.campaign_category,
              r.lead_business_name,
              r.lead_website,
              r.provider,
              r.errorMessage,
            ]
              .map(csvCell)
              .join(',') + '\n',
        )
        .join('')
    );
  return rows.map((r) => rowView('outreach.DeliveryLogRow', r));
}
