import Link from "next/link";
import { ArrowRight, Cable, CircleHelp, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

const resources = [
  { title: "Connections", body: "Connected provider accounts and their account identifiers live here.", href: "/connections", icon: Cable },
  { title: "Capabilities", body: "Use the public API capability catalog to discover supported reads and actions.", href: "/developers/api", icon: ShieldCheck },
  { title: "MCP guidance", body: "Learn when to use remote MCP, local stdio, one Developer API key, and REST.", href: "/developers/mcp", icon: CircleHelp },
];

export default function ResourcesPage() {
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6"><div className="mx-auto max-w-[1440px] space-y-6"><PageHeader><PageHeaderContent><PageHeaderTitle>Resources</PageHeaderTitle><PageHeaderDescription>Developer references and workspace controls.</PageHeaderDescription></PageHeaderContent></PageHeader><MotionReveal className="grid gap-3 md:grid-cols-2">{resources.map(({ title, body, href, icon: Icon }) => <Link key={href} href={href} className="group"><Card className="h-full gap-2 transition-colors group-hover:border-primary/40"><CardContent className="flex items-start gap-3 p-5"><Icon className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">{title}</h2><p className="mt-2 text-sm leading-5 text-muted-foreground">{body}</p><span className="mt-3 inline-flex items-center text-sm font-medium">Open <ArrowRight className="ml-1.5 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span></div></CardContent></Card></Link>)}</MotionReveal></div></div>
  );
}
