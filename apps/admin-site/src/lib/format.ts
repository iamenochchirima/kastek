const adminNumber = new Intl.NumberFormat("en-ZA");
const adminCurrency = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 2 });

export function formatAdminNumber(value: number | bigint | null | undefined) {
  return value == null ? "—" : adminNumber.format(Number(value));
}

export function formatAdminCurrency(value: number | null | undefined) {
  return value == null ? "—" : adminCurrency.format(value);
}

export function formatAdminDate(value: string | number | Date | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (value == null) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en-ZA", options ?? { dateStyle: "medium" }).format(date);
}

export function truncateAdminText(value: string | null | undefined, maxLength: number) {
  if (!value) return "—";
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…` : value;
}

export async function copyAdminText(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
