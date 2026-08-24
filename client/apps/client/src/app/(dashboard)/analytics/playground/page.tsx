import { notFound, redirect } from "next/navigation";
import { AnalyticsPlayground } from "@/components/analytics/analytics-playground";
import { getRustSession } from "@/lib/rust-auth";

export const metadata = { title: "Analytics Playground | KasiTek" };

export default async function AnalyticsPlaygroundPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.emailVerified) redirect(`/verify-request?email=${encodeURIComponent(session.user.email)}`);
  return <AnalyticsPlayground />;
}
