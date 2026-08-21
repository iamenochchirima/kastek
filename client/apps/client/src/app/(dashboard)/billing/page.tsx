import { BillingPanel } from "@/components/dashboard/billing/billing-panel";
import { fetchBillingPlans, fetchBillingSummary } from "@/lib/billing";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Billing and Usage | KasiTek",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; reference?: string; trxref?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [summary, planResponse, query] = await Promise.all([
    fetchBillingSummary().catch(() => null),
    fetchBillingPlans().catch(() => ({ plans: [] })),
    searchParams,
  ]);

  return <BillingPanel summary={summary} planResponse={planResponse} query={query} />;
}
