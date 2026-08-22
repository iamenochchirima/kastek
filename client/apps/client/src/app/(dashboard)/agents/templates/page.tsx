import { Bot, Globe2, MessageCircle, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = { title: "Agent Templates | KasiTek" };

type Template = { key: string; profile: "custom"; category: string; name: string; description: string; version: number; requiredConnections: string[]; requiredCapabilities: string[]; setupSteps: string[] };

const icons = [Sparkles, Globe2, MessageCircle, UserRound, Bot];

export default async function AgentTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { audience } = await searchParams;
  const selectedAudience = audience === "customer_service" ? "customer_service" : "personal";
  const response = await fetchRustJson<{ templates: Template[] }>("/api/agents/templates").catch(() => ({ templates: [] }));

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader className="max-w-3xl">
          <PageHeaderContent>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <PageHeaderTitle>Agent templates</PageHeaderTitle>
          <PageHeaderDescription>Starting points for new agents.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>
        <MotionReveal delay={0.08}>
        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Agent templates">
          {response.templates.map((template, index) => {
            const Icon = icons[index % icons.length]!;
            return (
              <Link key={template.key} href={`/agents/new?template=${encodeURIComponent(template.key)}&audience=${selectedAudience}`} className="min-h-64 rounded-xl border border-border bg-card p-5 transition-[border-color,background-color,transform] duration-[150ms] hover:-translate-y-0.5 hover:border-primary/50 hover:bg-secondary/35">
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-secondary text-foreground"><Icon className="h-5 w-5" /></span>
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Custom blueprint · v{template.version}</span>
                </div>
                <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground">{template.name}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{template.description}</p>
                <p className="mt-5 text-xs text-muted-foreground">{template.requiredConnections.length ? `Requires: ${template.requiredConnections.join(", ")}` : "No connection required to install"}</p>
                <p className="mt-2 text-xs text-muted-foreground">Setup: {template.setupSteps.join(" · ")}</p>
                <span className="mt-4 inline-flex text-sm font-medium text-foreground">Configure this template →</span>
              </Link>
            );
          })}
        </section>
        </MotionReveal>
      </div>
    </div>
  );
}
