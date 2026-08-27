import { apiUrl } from "@/lib/server-api";
import type { BillingUsage } from "@/lib/billing";

export async function fetchBillingUsage(range: "7d" | "30d" | "90d" = "30d") {
  const response = await fetch(apiUrl(`/api/billing/usage?range=${range}`), {
    cache: "no-store",
    credentials: "include",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Billing usage request failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return response.json() as Promise<BillingUsage>;
}
