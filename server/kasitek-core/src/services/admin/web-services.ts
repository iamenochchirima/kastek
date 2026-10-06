import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import * as sql from './web_services-sql.js';
import { rowView } from './rows.js';
import {
  requireString,
  present,
  nullableDate,
  updateFields,
  missing,
  type ObjectValue,
} from './common.js';
const view = (row: ObjectValue) =>
  rowView('web_services.WebServiceLeadRow', row);
export async function listWebServices(pool: Pool, query: ObjectValue) {
  const rows = (await pool.query(sql.LIST_0)).rows;
  return rows
    .filter(
      (r) =>
        (query.callStatus == null || r.callStatus === query.callStatus) &&
        (query.category == null || r.category === query.category) &&
        (query.search == null ||
          String(r.businessName)
            .toLowerCase()
            .includes(String(query.search).toLowerCase()) ||
          String(r.address ?? '')
            .toLowerCase()
            .includes(String(query.search).toLowerCase())),
    )
    .map(view);
}
export async function getWebService(pool: Pool, id: string) {
  return view(
    (await pool.query(sql.GET_0, [id])).rows[0] ??
      missing('web service lead not found'),
  );
}
function args(body: ObjectValue, id: string, time: Date) {
  return [
    id,
    requireString(body, 'businessName'),
    body.website ?? null,
    body.address ?? null,
    requireString(body, 'category'),
    body.bizbayUrl ?? null,
    body.phone ?? null,
    body.email ?? null,
    body.callStatus ?? 'pending',
    body.notes ?? null,
    time,
    time,
  ];
}
export async function createWebService(pool: Pool, body: ObjectValue) {
  const id = createId();
  await pool.query(sql.CREATE_0, args(body, id, new Date()));
  return getWebService(pool, id);
}
export async function importWebServices(pool: Pool, bodies: ObjectValue[]) {
  const time = new Date();
  for (const body of bodies)
    await pool.query(sql.IMPORT_0, args(body, createId(), time));
  return { inserted: bodies.length };
}
export async function updateWebService(
  pool: Pool,
  id: string,
  input: ObjectValue,
) {
  const fields = [
    'businessName',
    'website',
    'address',
    'category',
    'bizbayUrl',
    'phone',
    'email',
    'callStatus',
    'notes',
    'callbackDate',
  ].map((key): [string, unknown] => [
    key,
    !present(input[key])
      ? undefined
      : key === 'callbackDate'
        ? nullableDate(input[key] as string)
        : input[key],
  ]);
  return view(
    await updateFields(
      pool,
      'WebServiceLead',
      id,
      sql.SELECT_COLS,
      fields,
      'web service lead not found',
    ),
  );
}
export async function deleteWebService(pool: Pool, id: string) {
  if (!(await pool.query(sql.DELETE_0, [id])).rows.length)
    missing('web service lead not found');
  return { deleted: true };
}
