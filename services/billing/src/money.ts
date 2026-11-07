import { roundDivide } from "./util.js";

export interface TaxBreakdown {
  subtotalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
}

/**
 * Plans can be quoted VAT-inclusive (the South African SMB default) or
 * VAT-exclusive (B2B). Paystack always charges the gross total.
 */
export function taxBreakdown(
  amountMinor: bigint,
  taxInclusive: boolean,
  taxRateBps: number,
): TaxBreakdown {
  if (amountMinor < 0n) throw new Error("Amount cannot be negative");
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000)
    throw new Error("Tax rate is invalid");
  if (taxInclusive) {
    const subtotal = roundDivide(
      amountMinor * 10_000n,
      10_000n + BigInt(taxRateBps),
    );
    return {
      subtotalMinor: subtotal,
      taxMinor: amountMinor - subtotal,
      totalMinor: amountMinor,
    };
  }
  const tax = roundDivide(amountMinor * BigInt(taxRateBps), 10_000n);
  return {
    subtotalMinor: amountMinor,
    taxMinor: tax,
    totalMinor: amountMinor + tax,
  };
}

export function addMonth(value: Date): Date {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export function periodFor(start: Date, interval: "monthly"): { start: Date; end: Date } {
  if (interval !== "monthly") throw new Error("Unsupported interval");
  return { start, end: addMonth(start) };
}

export function formatMoney(
  amountMinor: bigint,
  currency: string,
): string {
  return `${currency} ${(Number(amountMinor) / 100).toFixed(2)}`;
}
