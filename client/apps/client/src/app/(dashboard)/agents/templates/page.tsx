import { Bot, Globe2, MessageCircle, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = { title: "Agent Templates | KasiTek" };

type Template = { key: string; profile: "custom"; category: string; name: string; description: string; version: number; requiredConnections: string[]; requiredCapabilities: string[]; setupSteps: string[] };

const icons = [Sparkles, Globe2, MessageCircle, UserRound, Bot];

export default async function AgentTemplatesPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const response = await fetchRustJson<{ templates: Template[] }>("/api/agents/templates").catch(() => ({ templates: [] }));

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent templates</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Server-owned starting points with bounded instructions, policies, and installation rules.</p>
        </header>
        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Agent templates">
          {response.templates.map((template, index) => {
            const Icon = icons[index % icons.length]!;
            return (
              <Link key={template.key} href={`/agents/new?template=${encodeURIComponent(template.key)}`} className="min-h-64 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50 hover:bg-secondary/35">
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
      </div>
    </div>
  );
}
