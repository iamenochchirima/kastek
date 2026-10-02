import { notFound, redirect } from "next/navigation";
import { AnalyticsPlayground } from "@/components/analytics/analytics-playground";
import { getWorkspaceSession } from "@/lib/rust-auth";

export const metadata = { title: "Analytics Playground | KasiTek" };

export default async function AnalyticsPlaygroundPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");
  return <AnalyticsPlayground />;
}
