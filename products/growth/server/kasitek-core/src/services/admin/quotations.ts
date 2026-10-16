import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import * as sql from './quotations-sql.js';
import { rowView } from './rows.js';
import {
  requireString,
  present,
  str,
  parseDate,
  parseValidityDays,
  updateFields,
  missing,
  json,
  type ObjectValue,
} from './common.js';
const view = (row: ObjectValue) => rowView('quotations.QuotationRow', row);
export async function listQuotations(pool: Pool) {
  return (await pool.query(sql.LIST_QUOTATIONS_0)).rows.map(view);
}
export async function getQuotation(pool: Pool, id: string) {
  return view(
    (await pool.query(sql.GET_QUOTATION_0, [id])).rows[0] ??
      missing('quotation not found'),
  );
}
export async function createQuotation(pool: Pool, input: ObjectValue) {
  const id = createId(),
    time = new Date();
  await pool.query(sql.CREATE_QUOTATION_0, [
    id,
    requireString(input, 'businessName'),
    requireString(input, 'contactPerson'),
    requireString(input, 'contactEmail'),
    requireString(input, 'contactPhone'),
    parseDate(requireString(input, 'date')),
    input.serviceType ?? 'website_agent',
    requireString(input, 'title'),
    input.introduction ?? null,
    json(input.scopeOfWork),
    json(input.deliverables),
    json(input.implementationSteps),
    json(input.pricingItems),
    json(input.maintenanceIncludes),
    json(input.termsAndNotes),
    json(input.sectionOrder),
    json([]),
    json(input.noteSections),
    json([]),
    parseValidityDays(input.validityDays),
    input.status ?? 'draft',
    input.quoteRequestId ?? null,
    time,
    time,
  ]);
  return getQuotation(pool, id);
}
export async function updateQuotation(
  pool: Pool,
  id: string,
  input: ObjectValue,
) {
  const keys = [
      'businessName',
      'contactPerson',
      'contactEmail',
      'contactPhone',
      'date',
      'serviceType',
      'title',
      'introduction',
      'scopeOfWork',
      'deliverables',
      'implementationSteps',
      'pricingItems',
      'maintenanceIncludes',
      'termsAndNotes',
      'sectionOrder',
      'noteSections',
      'validityDays',
      'status',
      'quoteRequestId',
    ],
    jsonKeys = new Set([
      'scopeOfWork',
      'deliverables',
      'implementationSteps',
      'pricingItems',
      'maintenanceIncludes',
      'termsAndNotes',
      'sectionOrder',
      'noteSections',
    ]);
  const fields = keys.map((key): [string, unknown] => [
    key === 'sectionOrder'
      ? 'includedFunctionality'
      : key === 'noteSections'
        ? 'importantNotes'
        : key,
    !present(input[key])
      ? undefined
      : jsonKeys.has(key)
        ? json(input[key])
        : key === 'date'
          ? parseDate(input[key] as string)
          : key === 'validityDays'
            ? parseValidityDays(input[key])
            : key === 'quoteRequestId'
              ? str(input[key]) || null
              : input[key],
  ]);
  return view(
    await updateFields(
      pool,
      'Quotation',
      id,
      sql.SELECT_COLS,
      fields,
      'quotation not found',
    ),
  );
}
export async function deleteQuotation(pool: Pool, id: string) {
  if (!(await pool.query(sql.DELETE_QUOTATION_0, [id])).rows.length)
    missing('quotation not found');
  return { deleted: true };
}
