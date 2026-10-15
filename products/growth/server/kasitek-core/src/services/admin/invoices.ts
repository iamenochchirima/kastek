import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { isDeepStrictEqual } from 'node:util';
import * as sql from './invoices-sql.js';
import {
  bad,
  missing,
  requireString,
  present,
  str,
  parseDate,
  parseValidityDays,
  updateFields,
  json,
  type ObjectValue,
} from './common.js';
type Invoice = ObjectValue & {
  id: string;
  date: Date;
  billingMode: string;
  recurringActive: boolean;
  billingAnchorDay: number | null;
  reminderDaysAfterDue: number;
  validityDays: number;
  status: string;
  title: string;
  contactEmail: string;
  businessName: string;
  pricingItems: unknown;
};
type Run = ObjectValue & {
  id: string;
  cycleKey: string;
  issueDate: Date;
  dueDate: Date;
  paidAt: Date | null;
  sentAt: Date | null;
  reminderSentAt: Date | null;
  reminderDueAt: Date | null;
  status: string;
  sendStatus: string;
  reminderStatus: string;
  titleSnapshot: string;
  contactEmailSnapshot: string;
  businessNameSnapshot: string;
  pricingItemsSnapshot: unknown;
};
const expand = (value: string) =>
  value.replaceAll('{RUN_SELECT_COLS}', sql.RUN_SELECT_COLS);
const recurring = (i: Invoice) =>
  i.billingMode === 'monthly' && i.recurringActive;
const day = (date: Date) => date.getUTCDate();

export function invoiceInteger(value: unknown, fallback: number) {
  if (value === null || value === undefined) return fallback;
  if (
    typeof value === 'bigint' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  ) {
    const n = BigInt(value);
    return n >= -(1n << 63n) && n < 1n << 63n
      ? Number(BigInt.asIntN(32, n))
      : fallback;
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const n = BigInt(value);
    return n >= -(1n << 31n) && n < 1n << 31n ? Number(n) : fallback;
  }
  return fallback;
}
const anchor = (value: unknown, fallback: number) =>
    Math.max(1, Math.min(31, invoiceInteger(value, fallback))),
  reminder = (value: unknown) =>
    Math.max(0, Math.min(60, invoiceInteger(value, 3))),
  validity = (value: unknown) => Math.max(1, invoiceInteger(value, 14));
export function currentCycle(anchorDay: number, now: Date) {
  const startOf = (delta: number) => {
    const first = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1),
    );
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return new Date(
      Date.UTC(
        first.getUTCFullYear(),
        first.getUTCMonth(),
        Math.min(Math.max(1, anchorDay), last),
      ),
    );
  };
  let start = startOf(0);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day(now)),
  );
  if (today < start) start = startOf(-1);
  const nextMonth = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1),
    ),
    last = new Date(
      Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0),
    ).getUTCDate(),
    next = new Date(
      Date.UTC(
        nextMonth.getUTCFullYear(),
        nextMonth.getUTCMonth(),
        Math.min(Math.max(1, anchorDay), last),
      ),
    );
  return {
    start,
    end: new Date(+next - 86_400_000),
    key: start.toISOString().slice(0, 10),
  };
}
export function runState(
  invoice: Pick<Invoice, 'reminderDaysAfterDue'>,
  run: Run,
  now: Date,
): [string, string, Date | null] {
  if (run.paidAt) return ['paid', 'sent', run.reminderDueAt];
  if (!run.sentAt) return ['pending', 'not_needed', null];
  const due = new Date(
    +run.dueDate + invoice.reminderDaysAfterDue * 86_400_000,
  );
  if (run.reminderSentAt) return ['reminder_sent', 'sent', due];
  if (now >= run.dueDate)
    return now >= due
      ? ['reminder_due', 'pending', due]
      : ['overdue', 'not_needed', due];
  return ['sent', 'not_needed', due];
}
async function fetchInvoice(pool: Pool, id: string): Promise<Invoice> {
  return (
    (await pool.query(sql.FETCH_INVOICE_0, [id])).rows[0] ??
    missing('invoice not found')
  );
}
async function publishReminder(pool: Pool, invoice: Invoice, run: Run) {
  const admins = (await pool.query(sql.LIST_ADMIN_IDS_0)).rows;
  if (!admins.length) return;
  const key = `invoice-reminder-due-${run.id}`;
  if ((await pool.query(sql.PUBLISH_ADMIN_NOTIFICATION_0, [key])).rows.length)
    return;
  const id = createId();
  await pool.query(sql.PUBLISH_ADMIN_NOTIFICATION_1, [
    id,
    'Invoice reminder still needs to be sent',
    `${run.businessNameSnapshot} is overdue and still needs a reminder email for billing cycle ${run.cycleKey}.`,
    'invoice_run',
    run.id,
    json({
      invoiceId: invoice.id,
      invoiceRunId: run.id,
      businessName: run.businessNameSnapshot,
      cycleKey: run.cycleKey,
      dueDate: run.dueDate,
    }),
    key,
  ]);
  for (const admin of admins)
    await pool.query(sql.PUBLISH_ADMIN_NOTIFICATION_2, [
      createId(),
      id,
      admin.id,
    ]);
}
async function syncRun(pool: Pool, invoice: Invoice): Promise<Run | null> {
  if (!recurring(invoice)) return null;
  const now = new Date(),
    cycle = currentCycle(
      anchor(invoice.billingAnchorDay, day(invoice.date)),
      now,
    ),
    due = new Date(+cycle.start + invoice.validityDays * 86_400_000);
  let run = (
    await pool.query(expand(sql.SYNC_CURRENT_RUN_0), [invoice.id, cycle.key])
  ).rows[0] as Run | undefined;
  if (!run) {
    const id = createId();
    await pool.query(sql.SYNC_CURRENT_RUN_1, [
      id,
      invoice.id,
      cycle.key,
      cycle.start,
      cycle.start,
      cycle.end,
      due,
      json(invoice.pricingItems),
      invoice.title,
      invoice.contactEmail,
      invoice.businessName,
    ]);
    run = (await pool.query(expand(sql.SYNC_CURRENT_RUN_2), [id])).rows[0];
  }
  if (!run) return null;
  const [status, reminderStatus, reminderDueAt] = runState(invoice, run, now);
  if (
    status !== run.status ||
    reminderStatus !== run.reminderStatus ||
    Number(reminderDueAt) !== Number(run.reminderDueAt) ||
    run.titleSnapshot !== invoice.title ||
    run.contactEmailSnapshot !== invoice.contactEmail ||
    run.businessNameSnapshot !== invoice.businessName ||
    !isDeepStrictEqual(run.pricingItemsSnapshot, invoice.pricingItems)
  )
    await pool.query(sql.SYNC_CURRENT_RUN_3, [
      status,
      reminderStatus,
      reminderDueAt,
      json(invoice.pricingItems),
      invoice.title,
      invoice.contactEmail,
      invoice.businessName,
      run.id,
    ]);
  run = (await pool.query(expand(sql.SYNC_CURRENT_RUN_4), [run.id]))
    .rows[0] as Run;
  if (run.reminderStatus === 'pending')
    await publishReminder(pool, invoice, run).catch(() => {});
  return run;
}
function operations(invoice: Invoice, run: Run | null) {
  return {
    recurringClient: recurring(invoice),
    needsInvoiceSend:
      run !== null &&
      run.sendStatus === 'pending' &&
      new Date() >= run.issueDate,
    needsReminder: run !== null && run.reminderStatus === 'pending',
    cycleLabel: run?.cycleKey ?? null,
  };
}
async function response(pool: Pool, invoice: Invoice) {
  const currentRun = await syncRun(pool, invoice);
  if (currentRun) {
    const next =
      currentRun.status === 'paid'
        ? 'paid'
        : ['reminder_due', 'overdue', 'reminder_sent'].includes(
              currentRun.status,
            )
          ? 'overdue'
          : currentRun.status === 'sent'
            ? 'sent'
            : invoice.status;
    if (next !== invoice.status) {
      await pool.query(sql.INVOICE_RESPONSE_0, [next, invoice.id]);
      invoice.status = next;
    }
  }
  const recentRuns = (
    await pool.query(expand(sql.FETCH_RECENT_RUNS_0), [invoice.id, 6])
  ).rows;
  return {
    ...invoice,
    currentRun,
    recentRuns,
    operations: operations(invoice, currentRun),
  };
}
export async function getInvoice(pool: Pool, id: string) {
  return response(pool, await fetchInvoice(pool, id));
}
export async function listInvoices(pool: Pool) {
  const invoices: unknown[] = [],
    actionItems: ObjectValue[] = [],
    summary = {
      totalInvoices: 0,
      recurringClients: 0,
      needsInvoiceSend: 0,
      needsReminder: 0,
    };
  for (const invoice of (await pool.query(sql.LIST_INVOICES_0))
    .rows as Invoice[]) {
    const run = await syncRun(pool, invoice),
      op = operations(invoice, run);
    summary.totalInvoices++;
    if (op.recurringClient) summary.recurringClients++;
    if (op.needsInvoiceSend) summary.needsInvoiceSend++;
    if (op.needsReminder) summary.needsReminder++;
    if (run) {
      const common = {
        invoiceId: invoice.id,
        invoiceRunId: run.id,
        businessName: invoice.businessName,
      };
      if (op.needsInvoiceSend)
        actionItems.push({
          ...common,
          actionType: 'send_invoice',
          title: 'Monthly invoice still needs to be sent',
          message: `${invoice.businessName} is due for cycle ${run.cycleKey} and has not been marked sent yet.`,
          dueAt: run.issueDate,
        });
      if (op.needsReminder)
        actionItems.push({
          ...common,
          actionType: 'send_reminder',
          title: 'Payment reminder email still needs to be sent',
          message: `${invoice.businessName} is overdue for cycle ${run.cycleKey} and no reminder has been marked sent yet.`,
          dueAt: run.reminderDueAt ?? run.dueDate,
        });
    }
    const keys = [
      'id',
      'businessName',
      'contactPerson',
      'contactEmail',
      'contactPhone',
      'serviceType',
      'billingMode',
      'recurringActive',
      'title',
      'status',
      'pricingItems',
      'createdAt',
      'updatedAt',
    ];
    invoices.push({
      ...Object.fromEntries(keys.map((key) => [key, invoice[key]])),
      currentRun: run,
      operations: op,
    });
  }
  actionItems.sort((a, b) => +(a.dueAt as Date) - +(b.dueAt as Date));
  return { summary, actionItems, invoices };
}
export async function createInvoice(pool: Pool, input: ObjectValue) {
  const id = createId(),
    time = new Date(),
    date = parseDate(requireString(input, 'date')),
    mode = input.billingMode ?? 'one_off',
    active = input.recurringActive ?? mode === 'monthly';
  await pool.query(sql.CREATE_INVOICE_0, [
    id,
    requireString(input, 'businessName'),
    requireString(input, 'contactPerson'),
    requireString(input, 'contactEmail'),
    requireString(input, 'contactPhone'),
    date,
    input.serviceType ?? 'website_agent',
    mode,
    active,
    active ? anchor(input.billingAnchorDay, day(date)) : null,
    reminder(input.reminderDaysAfterDue),
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
    validity(input.validityDays),
    input.status ?? 'draft',
    input.quoteRequestId ?? null,
    time,
    time,
  ]);
  return getInvoice(pool, id);
}
export async function updateInvoice(
  pool: Pool,
  id: string,
  input: ObjectValue,
) {
  const existing = await fetchInvoice(pool, id),
    defaultAnchor = day(
      typeof input.date === 'string' ? parseDate(input.date) : existing.date,
    ),
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
  const fields = [
    'businessName',
    'contactPerson',
    'contactEmail',
    'contactPhone',
    'date',
    'serviceType',
    'billingMode',
    'recurringActive',
    'billingAnchorDay',
    'reminderDaysAfterDue',
    'title',
    'introduction',
    ...jsonKeys,
    'validityDays',
    'status',
    'quoteRequestId',
  ].map((key): [string, unknown] => [
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
            ? validity(input[key])
            : key === 'billingAnchorDay'
              ? input.recurringActive === false
                ? null
                : anchor(input[key], defaultAnchor)
              : key === 'reminderDaysAfterDue'
                ? reminder(input[key])
                : key === 'quoteRequestId'
                  ? str(input[key]) || null
                  : input[key],
  ]);
  return response(
    pool,
    (await updateFields(
      pool,
      'Invoice',
      id,
      sql.SELECT_COLS,
      fields,
      'invoice not found',
    )) as Invoice,
  );
}
export async function invoiceRunAction(
  pool: Pool,
  invoiceId: string,
  runId: string,
  action: string,
) {
  const invoice = await fetchInvoice(pool, invoiceId),
    run =
      (await pool.query(expand(sql.INVOICE_RUN_ACTION_0), [runId, invoiceId]))
        .rows[0] ?? missing('invoice run not found'),
    time = new Date();
  switch (action) {
    case 'mark_sent':
      await pool.query(sql.INVOICE_RUN_ACTION_1, [
        time,
        time,
        new Date(+run.dueDate + invoice.reminderDaysAfterDue * 86_400_000),
        runId,
      ]);
      await pool.query(sql.INVOICE_RUN_ACTION_2, [time, invoiceId]);
      break;
    case 'mark_reminder_sent':
      await pool.query(sql.INVOICE_RUN_ACTION_3, [time, runId]);
      await pool.query(sql.INVOICE_RUN_ACTION_4, [time, invoiceId]);
      break;
    case 'mark_paid':
      await pool.query(sql.INVOICE_RUN_ACTION_5, [time, runId]);
      await pool.query(sql.INVOICE_RUN_ACTION_6, [time, invoiceId]);
      break;
    case 'reopen_cycle':
      await pool.query(sql.INVOICE_RUN_ACTION_7, [runId]);
      await pool.query(sql.INVOICE_RUN_ACTION_8, [invoiceId]);
      break;
    default:
      bad('unsupported invoice action');
  }
  return getInvoice(pool, invoiceId);
}
export async function deleteInvoice(pool: Pool, id: string) {
  if (!(await pool.query(sql.DELETE_INVOICE_0, [id])).rows.length)
    missing('invoice not found');
  return { deleted: true };
}
