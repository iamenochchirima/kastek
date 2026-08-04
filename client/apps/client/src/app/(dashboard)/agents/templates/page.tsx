import { Bot, Globe2, MessageCircle, Mic, Workflow } from "lucide-react";
import Link from "next/link";

export const metadata = { title: "Agent Templates | KasiTek" };

const templates = [
  {
    name: "WhatsApp enquiry agent",
    description: "Start with inbound questions, qualification and a clear handoff to the team.",
    href: "/agents?template=whatsapp_agent",
    icon: MessageCircle,
    available: true,
  },
  {
    name: "Website enquiry agent",
    description: "Capture website enquiries, collect useful context and route the next step.",
    href: "/agents?template=website_agent",
    icon: Globe2,
    available: true,
  },
  {
    name: "Instagram response agent",
    description: "Handle direct-message enquiries with the same business context.",
    icon: MessageCircle,
    available: false,
  },
  {
    name: "Messenger response agent",
    description: "Qualify Messenger conversations and prepare work for the right person.",
    icon: Bot,
    available: false,
  },
  {
    name: "Voice intake agent",
    description: "Answer, qualify and route incoming calls using an agreed escalation path.",
    icon: Mic,
    available: false,
  },
  {
    name: "Internal workflow agent",
    description: "Carry out a defined internal process across connected systems and approvals.",
    icon: Workflow,
    available: false,
  },
];

export default function AgentTemplatesPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Automation
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent templates</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Choose a starting point, connect the relevant channel, then configure it for your operation.
          </p>
        </header>

        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Agent templates">
          {templates.map((template) => {
            const content = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-lg bg-secondary text-foreground">
                    <template.icon className="h-5 w-5" />
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    template.available
                      ? "border-accent/30 bg-accent/10 text-accent"
                      : "border-border bg-secondary text-muted-foreground"
                  }`}>
                    {template.available ? "Available" : "Coming soon"}
                  </span>
                </div>
                <h2 className="mt-8 text-lg font-semibold tracking-tight text-foreground">{template.name}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{template.description}</p>
                <span className="mt-6 inline-flex text-sm font-medium text-foreground">
                  {template.available ? "Use this template →" : "In development"}
                </span>
              </>
            );

            return template.available ? (
              <Link
                key={template.name}
                href={template.href!}
                className="min-h-64 rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50 hover:bg-secondary/35"
              >
                {content}
              </Link>
            ) : (
              <article key={template.name} className="min-h-64 rounded-xl border border-border bg-card p-5 opacity-65">
                {content}
              </article>
            );
          })}
        </section>
      </div>
    </div>
  );
}
