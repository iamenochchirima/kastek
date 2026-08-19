import Link from "next/link";
import { ArrowRight, Cable, CircleHelp, GitBranch, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const resources = [
  { title: "Connections", body: "Connected provider accounts and their account identifiers live here.", href: "/connections", icon: Cable },
  { title: "Agent installations", body: "Review external agents, grants, activity, credentials, and revoke controls.", href: "/agents", icon: GitBranch },
  { title: "Capabilities", body: "Use the public API capability catalog to discover supported reads and actions.", href: "/developers/api", icon: ShieldCheck },
  { title: "MCP guidance", body: "Learn when to use remote MCP, local stdio, one Developer API key, and REST.", href: "/developers/mcp", icon: CircleHelp },
];

export default function ResourcesPage() {
  return (
    <div className="p-5 lg:p-8"><div className="mx-auto max-w-[1080px] space-y-7"><header><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Resources</p><h1 className="mt-1 text-2xl font-semibold tracking-tight">Find the right KasiTek surface</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Developers explains how to connect and call KasiTek. The linked product areas own the workspace data and operational controls.</p></header><div className="grid gap-3 md:grid-cols-2">{resources.map(({ title, body, href, icon: Icon }) => <Link key={href} href={href} className="group"><Card className="h-full gap-2 transition-colors group-hover:border-primary/40"><CardContent className="flex items-start gap-3 p-5"><Icon className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-2 text-sm leading-5 text-muted-foreground">{body}</p><span className="mt-3 inline-flex items-center text-sm font-medium">Open <ArrowRight className="ml-1.5 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span></div></CardContent></Card></Link>)}</div></div></div>
  );
}
