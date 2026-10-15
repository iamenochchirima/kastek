import { redirect } from "next/navigation";

export const metadata = {
  title: "Billing and Usage | KasiTek",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; reference?: string; trxref?: string }>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams({ section: "billing" });
  for (const key of ["payment", "reference", "trxref"] as const) {
    if (query[key]) params.set(key, query[key]!);
  }
  redirect(`/workspace/settings?${params.toString()}`);
}
