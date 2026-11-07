import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  BillingInvoiceSummary,
  BillingProduct,
} from "@kasitek-labs/contracts";
import { taxBreakdown } from "./money.js";
import type { PlanVersionRow } from "./catalog.js";
import { missing, wire } from "./util.js";

export interface CreateInvoiceInput {
  billingAccountId: string;
  subscriptionId: string | null;
  checkoutId: string | null;
  plan: PlanVersionRow;
  periodStart: Date | null;
  periodEnd: Date | null;
  provider: string | null;
  providerInvoiceId: string | null;
  providerTransactionId: string | null;
  status: "draft" | "open" | "paid";
  metadata?: Record<string, unknown>;
}

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  billing_account_id: string;
  subscription_id: string | null;
  checkout_id: string | null;
  provider: string | null;
  provider_invoice_id: string | null;
  provider_transaction_id: string | null;
  status: string;
  currency: string;
  subtotal_minor: string;
  tax_minor: string;
  total_minor: string;
  tax_rate_bps: number;
  tax_inclusive: boolean;
  period_start: Date | null;
  period_end: Date | null;
  issued_at: Date;
  due_at: Date | null;
  paid_at: Date | null;
  metadata: unknown;
}

export async function nextInvoiceNumber(
  client: PoolClient,
  prefix: string,
): Promise<string> {
  const result = await client.query<{ value: string }>(
    `SELECT nextval('billing.invoice_number_seq')::text AS value`,
  );
  const serial = String(result.rows[0]!.value).padStart(6, "0");
  return `${prefix}-${new Date().getUTCFullYear()}-${serial}`;
}

export async function createInvoiceTx(
  client: PoolClient,
  input: CreateInvoiceInput,
  prefix: string,
): Promise<InvoiceRow> {
  const amount = BigInt(input.plan.amount_minor);
  const tax = taxBreakdown(amount, input.plan.tax_inclusive, input.plan.tax_rate_bps);
  const id = `inv_${randomUUID()}`;
  const invoiceNumber = await nextInvoiceNumber(client, prefix);
  const result = await client.query<InvoiceRow>(
    `INSERT INTO billing.invoices(
       id, invoice_number, billing_account_id, subscription_id, checkout_id,
       provider, provider_invoice_id, provider_transaction_id, status, currency,
       subtotal_minor, tax_minor, total_minor, tax_rate_bps, tax_inclusive,
       period_start, period_end, issued_at, paid_at, metadata
     ) VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),
       CASE WHEN $9='paid' THEN now() ELSE NULL END,$18
     )
     RETURNING id, invoice_number, billing_account_id, subscription_id, checkout_id,
               provider, provider_invoice_id, provider_transaction_id, status, currency,
               subtotal_minor::text, tax_minor::text, total_minor::text,
               tax_rate_bps, tax_inclusive, period_start, period_end, issued_at,
               due_at, paid_at, metadata`,
    [
      id,
      invoiceNumber,
      input.billingAccountId,
      input.subscriptionId,
      input.checkoutId,
      input.provider,
      input.providerInvoiceId,
      input.providerTransactionId,
      input.status,
      input.plan.currency,
      tax.subtotalMinor.toString(),
      tax.taxMinor.toString(),
      tax.totalMinor.toString(),
      input.plan.tax_rate_bps,
      input.plan.tax_inclusive,
      input.periodStart,
      input.periodEnd,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const description =
    input.periodStart && input.periodEnd
      ? `${input.plan.plan_name} — ${input.periodStart.toISOString().slice(0, 10)} to ${input.periodEnd.toISOString().slice(0, 10)}`
      : `${input.plan.plan_name} — one billing period`;
  await client.query(
    `INSERT INTO billing.invoice_lines(
       id, invoice_id, product_key, plan_key, description, quantity,
       unit_amount_minor, amount_minor, period_start, period_end, metadata
     ) VALUES($1,$2,$3,$4,$5,1,$6,$6,$7,$8,$9)`,
    [
      `inl_${randomUUID()}`,
      id,
      input.plan.product_key,
      input.plan.plan_key,
      description,
      tax.subtotalMinor.toString(),
      input.periodStart,
      input.periodEnd,
      JSON.stringify({ planVersionId: input.plan.id, planVersion: input.plan.version }),
    ],
  );
  return result.rows[0]!;
}

export async function findInvoiceByProviderInvoice(
  pool: Pool | PoolClient,
  provider: string,
  providerInvoiceId: string,
): Promise<InvoiceRow | null> {
  const result = await pool.query<InvoiceRow>(
    `SELECT id, invoice_number, billing_account_id, subscription_id, checkout_id,
            provider, provider_invoice_id, provider_transaction_id, status, currency,
            subtotal_minor::text, tax_minor::text, total_minor::text,
            tax_rate_bps, tax_inclusive, period_start, period_end, issued_at,
            due_at, paid_at, metadata
       FROM billing.invoices WHERE provider=$1 AND provider_invoice_id=$2`,
    [provider, providerInvoiceId],
  );
  return result.rows[0] ?? null;
}

export async function findInvoiceByCheckout(
  pool: Pool | PoolClient,
  checkoutId: string,
): Promise<InvoiceRow | null> {
  const result = await pool.query<InvoiceRow>(
    `SELECT id, invoice_number, billing_account_id, subscription_id, checkout_id,
            provider, provider_invoice_id, provider_transaction_id, status, currency,
            subtotal_minor::text, tax_minor::text, total_minor::text,
            tax_rate_bps, tax_inclusive, period_start, period_end, issued_at,
            due_at, paid_at, metadata
       FROM billing.invoices WHERE checkout_id=$1`,
    [checkoutId],
  );
  return result.rows[0] ?? null;
}

export async function markInvoiceRefunded(
  client: PoolClient,
  invoiceId: string,
  status: "refunded" | "partially_refunded",
): Promise<void> {
  await client.query(
    `UPDATE billing.invoices SET status=$2, updated_at=now() WHERE id=$1`,
    [invoiceId, status],
  );
}

export async function listInvoices(
  pool: Pool,
  billingAccountId: string,
  limit = 100,
): Promise<BillingInvoiceSummary[]> {
  const invoices = await pool.query<InvoiceRow>(
    `SELECT id, invoice_number, billing_account_id, subscription_id, checkout_id,
            provider, provider_invoice_id, provider_transaction_id, status, currency,
            subtotal_minor::text, tax_minor::text, total_minor::text,
            tax_rate_bps, tax_inclusive, period_start, period_end, issued_at,
            due_at, paid_at, metadata
       FROM billing.invoices WHERE billing_account_id=$1
      ORDER BY issued_at DESC, id DESC LIMIT $2`,
    [billingAccountId, Math.min(500, Math.max(1, limit))],
  );
  if (!invoices.rows.length) return [];
  const lines = await pool.query<{
    id: string;
    invoice_id: string;
    description: string;
    quantity: number;
    unit_amount_minor: string;
    amount_minor: string;
    product_key: BillingProduct | null;
    plan_key: string | null;
  }>(
    `SELECT id, invoice_id, description, quantity,
            unit_amount_minor::text, amount_minor::text, product_key, plan_key
       FROM billing.invoice_lines WHERE invoice_id = ANY($1::text[])
      ORDER BY id`,
    [invoices.rows.map((invoice) => invoice.id)],
  );
  const byInvoice = new Map<string, typeof lines.rows>();
  for (const line of lines.rows) {
    const list = byInvoice.get(line.invoice_id) ?? [];
    list.push(line);
    byInvoice.set(line.invoice_id, list);
  }
  return invoices.rows.map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    status: invoice.status as BillingInvoiceSummary["status"],
    currency: invoice.currency,
    subtotalMinor: invoice.subtotal_minor,
    taxMinor: invoice.tax_minor,
    totalMinor: invoice.total_minor,
    taxRateBps: invoice.tax_rate_bps,
    taxInclusive: invoice.tax_inclusive,
    periodStart: invoice.period_start?.toISOString() ?? null,
    periodEnd: invoice.period_end?.toISOString() ?? null,
    issuedAt: invoice.issued_at.toISOString(),
    paidAt: invoice.paid_at?.toISOString() ?? null,
    lines: (byInvoice.get(invoice.id) ?? []).map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitAmountMinor: line.unit_amount_minor,
      amountMinor: line.amount_minor,
      product: line.product_key,
      planKey: line.plan_key,
    })),
  }));
}

export async function getInvoice(
  pool: Pool,
  invoiceId: string,
): Promise<BillingInvoiceSummary> {
  const invoice = await pool.query<InvoiceRow>(
    `SELECT id, invoice_number, billing_account_id, subscription_id, checkout_id,
            provider, provider_invoice_id, provider_transaction_id, status, currency,
            subtotal_minor::text, tax_minor::text, total_minor::text,
            tax_rate_bps, tax_inclusive, period_start, period_end, issued_at,
            due_at, paid_at, metadata
       FROM billing.invoices WHERE id=$1`,
    [invoiceId],
  );
  if (!invoice.rows[0]) missing("Invoice not found");
  const listed = await listInvoices(pool, invoice.rows[0].billing_account_id, 500);
  const found = listed.find((item) => item.id === invoiceId);
  if (!found) missing("Invoice not found");
  return found;
}

export function invoiceTotal(invoice: InvoiceRow): string {
  return wire(invoice.total_minor);
}
