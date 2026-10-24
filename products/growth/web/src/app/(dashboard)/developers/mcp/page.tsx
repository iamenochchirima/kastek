import { McpPageClient } from "@/components/dashboard/developers/mcp-page-client";

export function meta() { return [{ title: "MCP | Developers | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function DevelopersMcpPage() {
  return <McpPageClient />;
}
