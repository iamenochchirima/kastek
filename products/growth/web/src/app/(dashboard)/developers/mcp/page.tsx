import { McpPageClient } from "@/components/dashboard/developers/mcp-page-client";
import { useRouteLoaderData } from "react-router";

export function meta() { return [{ title: "MCP | Developers | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function DevelopersMcpPage() {
  const workspace=useRouteLoaderData("app/(dashboard)/layout") as {activeOrgId?:string;session?:{user:{id:string}}}|undefined;
  return <McpPageClient key={`${workspace?.session?.user.id??""}:${workspace?.activeOrgId??""}`} />;
}
