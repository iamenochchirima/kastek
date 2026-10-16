import Link from "@/lib/link";
import { Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export function PersonalDeploymentSummary() {
  return <Card><CardContent className="space-y-4 p-6 sm:p-8">
    <Terminal className="size-7 text-muted-foreground" />
    <div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold">Personal deployments</h2><span className="rounded-full bg-secondary px-2 py-1 text-xs text-muted-foreground">Planned</span></div>
    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Run your own filesystem-based agent in an isolated workspace with persistent files, skills and memory. Deployment controls are not available yet.</p>
    <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Hosted workspace assistants remain in API-based agents. Their private audience does not make them a personal runtime deployment.</p>
    <Button asChild variant="outline"><Link href="/app/agents/personal">View planned deployment workspace</Link></Button>
  </CardContent></Card>;
}

export function PersonalDeployments() {
  return <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">
    <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Personal deployments · Planned</p>
    <h1 className="mt-3 text-2xl font-semibold">Your own agent workspace</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">This area will manage the separate personal agent runtime we are building. No containers or deployments are provisioned from this screen yet.</p>
    <div className="mt-7 grid gap-4 sm:grid-cols-2">
      {[['Workspace and files', 'Persistent files and agent memory in a workspace isolated for each deployment.'], ['Runtime and skills', 'A pinned runtime version, instructions, skills and authorized tools.'], ['Deployment controls', 'Start, stop and inspect runtime status, logs and resource usage.'], ['Channels and product tools', 'Connect supported messaging channels and scoped tools for Growth, Agency and future products.']].map(([title, description]) => <Card key={title}><CardContent className="p-5"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p><p className="mt-3 text-xs text-muted-foreground">Planned</p></CardContent></Card>)}
    </div>
    <Button asChild variant="outline" className="mt-7"><Link href="/app/agents">Back to API-based agents</Link></Button>
  </div>;
}
