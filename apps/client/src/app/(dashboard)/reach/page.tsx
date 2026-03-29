import Link from "next/link";
import { Bell, FileText, Send, Settings, Users } from "lucide-react";

const sections = [
  {
    title: "Contacts",
    href: "/reach/contacts",
    description: "Import, segment, and manage the audience you can send to.",
    icon: Users,
  },
  {
    title: "Templates",
    href: "/reach/templates",
    description: "Create, sync, and manage WhatsApp templates for campaigns.",
    icon: FileText,
  },
  {
    title: "Campaigns",
    href: "/reach/campaigns",
    description: "Launch outbound campaigns and track delivery performance.",
    icon: Send,
  },
  {
    title: "Inbox Handoff",
    href: "/inbox",
    description: "Open the inbox when campaign replies need support or follow-up.",
    icon: Bell,
  },
  {
    title: "Channel Settings",
    href: "/reach/settings",
    description: "Manage WhatsApp connections, alerting, and operational setup.",
    icon: Settings,
  },
];

export default function ReachPage() {
  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">KasiReach</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Outbound growth workspace</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
            Use Reach to manage audiences, message templates, and campaigns across outbound channels. When replies come in, hand off naturally into KasiInbox.
          </p>
        </div>

        <div className="grid gap-5 xl:grid-cols-2">
          {sections.map((section) => (
            <Link
              key={section.title}
              href={section.href}
              className="rounded-[24px] border border-border bg-card p-5 no-underline transition-all duration-200 hover:-translate-y-1 hover:border-primary/20 hover:bg-secondary/20 sm:rounded-[28px] sm:p-7"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-secondary/50">
                <section.icon className="h-5 w-5 text-primary" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">{section.title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{section.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
