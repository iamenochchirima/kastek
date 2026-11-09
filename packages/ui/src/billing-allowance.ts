export interface BillingAllowanceInput {
  used: number;
  available: number;
  warningPercent?: number;
}

export interface BillingAllowanceState {
  total: number;
  percent: number;
  exhausted: boolean;
  approaching: boolean;
}

export function billingAllowance({
  used,
  available,
  warningPercent = 80,
}: BillingAllowanceInput): BillingAllowanceState {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const safeAvailable = Number.isFinite(available) && available > 0 ? available : 0;
  const total = safeUsed + safeAvailable;
  const percent = total > 0 ? Math.min(100, Math.round((safeUsed / total) * 100)) : 0;
  const exhausted = total > 0 && safeAvailable <= 0;
  return {
    total,
    percent,
    exhausted,
    approaching: !exhausted && percent >= warningPercent,
  };
}
