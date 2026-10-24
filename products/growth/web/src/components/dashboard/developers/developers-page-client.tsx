import { Link } from "react-router";
import { ArrowRight, Code2, KeyRound, Terminal } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

export function DevelopersPageClient() {
  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>Developers</PageHeaderTitle><PageHeaderDescription>REST API and terminal setup.</PageHeaderDescription></PageHeaderContent></PageHeader>
        <MotionReveal>
          <h2 className="text-lg font-semibold text-foreground">Choose a path</h2>
          <p className="mt-1 text-sm text-muted-foreground">Use the public REST API from your code or terminal.</p>

          <div className="mt-4 grid gap-3 overflow-x-auto lg:grid-cols-2">
            <Link to="/developers/api" className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
              <Code2 className="h-5 w-5 text-muted-foreground" />
              <h2 className="mt-4 text-base font-semibold">Build with the API or SDK</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Schedule and publish from your own code using the public REST API.</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">Create a key <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
            <Link to="/developers/cli" className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
              <Terminal className="h-5 w-5 text-muted-foreground" />
              <h2 className="mt-4 text-base font-semibold">Use the command line</h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">Use cURL from your terminal and scripts.</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-foreground">CLI setup <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Create a Developer API key, then test a read request.</p>
        </MotionReveal>

        <MotionReveal delay={0.16} className="grid gap-3 md:grid-cols-2">
          <Card className="gap-3" data-motion-card>
            <CardContent className="flex items-start gap-3 p-5"><KeyRound className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">Developer API keys</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Use a workspace API key for REST and scripts. Permissions and approvals still apply.</p><Link to="/developers/api-keys" className="mt-3 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline">Manage API keys <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></div></CardContent>
          </Card>
          <Card className="gap-3" data-motion-card>
            <CardContent className="flex items-start gap-3 p-5"><Code2 className="mt-0.5 h-5 w-5 text-muted-foreground" /><div><h2 className="text-sm font-semibold">Connected accounts</h2><p className="mt-1 text-sm leading-5 text-muted-foreground">Provider accounts and account identifiers are managed in Connections, not duplicated here.</p><Link to="/connections" className="mt-3 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline">Open Connections <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link></div></CardContent>
          </Card>
        </MotionReveal>
      </div>
    </div>
  );
}
