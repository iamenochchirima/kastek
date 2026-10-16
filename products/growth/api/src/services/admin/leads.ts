import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import type { AdminUser } from '../../identity/admin-session.js';
import * as sql from './leads-sql.js';
import { rowView } from './rows.js';
import {
  str,
  present,
  requireString,
  missing,
  nullableDate,
  updateFields,
  json,
  type ObjectValue,
} from './common.js';
const view = (row: ObjectValue) => rowView('leads.QuoteRequestRow', row);
export async function listLeads(pool: Pool, query: ObjectValue) {
  const rows = (await pool.query(sql.LIST_LEADS_0)).rows;
  return rows
    .filter((row) => {
      const search = str(query.search)?.toLowerCase();
      return (
        (str(query.status) === null || row.status === query.status) &&
        (str(query.source) === null || row.source === query.source) &&
        (search === undefined ||
          [row.businessName, row.contactPerson, row.email].some((value) =>
            value.toLowerCase().includes(search),
          ) ||
          row.phone.includes(search))
      );
    })
    .map(view);
}
export async function getLead(pool: Pool, id: string) {
  return view(
    (await pool.query(sql.GET_LEAD_0, [id])).rows[0] ??
      missing('lead not found'),
  );
}
export async function createLead(pool: Pool, input: ObjectValue) {
  const id = createId(),
    now = new Date();
  await pool.query(sql.CREATE_LEAD_0, [
    id,
    requireString(input, 'businessName'),
    requireString(input, 'contactPerson'),
    requireString(input, 'phone'),
    requireString(input, 'email'),
    requireString(input, 'businessType'),
    input.services ?? [],
    input.description ?? null,
    input.source ?? 'website',
    input.status ?? 'new',
    input.quoteAmount ?? null,
    input.assignedToId ?? null,
    now,
    now,
  ]);
  return getLead(pool, id);
}
export async function updateLead(pool: Pool, id: string, input: ObjectValue) {
  const keys = [
      'businessName',
      'contactPerson',
      'phone',
      'email',
      'businessType',
      'services',
      'description',
      'source',
      'status',
      'quoteAmount',
      'followUpDate',
      'notes',
      'assignedToId',
    ],
    fields = keys.map((key): [string, unknown] => [
      key,
      !present(input[key])
        ? undefined
        : key === 'followUpDate'
          ? nullableDate(input[key] as string)
          : key === 'notes'
            ? json(input[key])
            : input[key],
    ]);
  return view(
    await updateFields(
      pool,
      'QuoteRequest',
      id,
      sql.SELECT_COLS,
      fields,
      'lead not found',
    ),
  );
}
export async function deleteLead(pool: Pool, id: string) {
  if (!(await pool.query(sql.DELETE_LEAD_0, [id])).rows.length)
    missing('lead not found');
  return { deleted: true };
}
export async function addLeadNote(
  pool: Pool,
  admin: AdminUser,
  id: string,
  input: ObjectValue,
) {
  const note = {
      text: requireString(input, 'text'),
      timestamp: new Date().toISOString().replace(/Z$/, '+00:00'),
      adminUserId: admin.id,
      adminUserName: input.adminUserName ?? admin.name,
    },
    row =
      (await pool.query(sql.ADD_NOTE_0, [json([note]), id])).rows[0] ??
      missing('lead not found');
  return { notes: row.notes };
}
