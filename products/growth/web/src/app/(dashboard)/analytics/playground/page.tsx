import { redirect } from "react-router";
import { AnalyticsPlayground } from "@/components/analytics/analytics-playground";
import { getWorkspaceSession } from "@/lib/core-auth";

export function meta() { return [{ title: "Analytics Playground | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader() {
  if (!import.meta.env.DEV) throw new Response("Not found", { status: 404 });
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");
  return {  };
}

export default function AnalyticsPlaygroundPage() {
  return <AnalyticsPlayground />;
}
