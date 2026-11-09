import { useLoaderData } from "react-router";

import { PublicPricingPage } from "@/components/pricing/public-pricing-page";
import type { AvailablePlan } from "@/lib/billing";

export function meta() {
  return [
    { title: "Pricing | KasiTek Growth" },
    { name: "description", content: "Monthly plans for KasiTek Growth. Start free, then add campaigns, content and workspace agents." },
    { name: "robots", content: "index, follow" },
    { tagName: "link", rel: "canonical", href: "https://app.kasitek.co.za/pricing" },
  ];
}

export async function clientLoader() {
  try {
    const response = await fetch("/api/public/plans", { cache: "no-store" });
    if (!response.ok) return { configured: false, plans: [] as AvailablePlan[] };
    return (await response.json()) as { configured: boolean; plans: AvailablePlan[] };
  } catch {
    return { configured: false, plans: [] as AvailablePlan[] };
  }
}

export default function PricingRoute() {
  const data = useLoaderData<typeof clientLoader>();
  return <PublicPricingPage plans={data.plans} configured={data.configured} />;
}
