import type { Metadata } from "next";
import Link from "next/link";
import {
  BarChart3,
  Bot,
  CheckCircle2,
  Facebook,
  Instagram,
  MessageCircle,
  MessagesSquare,
  ShieldCheck,
} from "lucide-react";
import { Footer } from "@/components/landing/Footer";
import { Navbar } from "@/components/landing/Navbar";

export const metadata: Metadata = {
  title: "Meta Business Platform Services | KasiTek",
  description:
    "KasiTek helps businesses manage WhatsApp, Facebook Page, and Instagram communication through official Meta business APIs.",
};

const channels = [
  {
    title: "WhatsApp Business",
    description:
      "Manage WhatsApp customer conversations, approved templates, campaign replies, delivery events, and automation workflows.",
    icon: MessageCircle,
  },
  {
    title: "Facebook Pages",
    description:
      "Connect Facebook Pages to manage messages, page activity, comments, and customer engagement from the KasiTek workspace.",
    icon: Facebook,
  },
  {
    title: "Instagram Business",
    description:
      "Support Instagram messaging, content workflows, post activity, comments, and account engagement in one operating layer.",
    icon: Instagram,
  },
];

const capabilities = [
  "Connect client-owned Meta business assets with permissioned account access",
  "Manage messages, replies, comments, and customer conversations across multiple inboxes",
  "Create, schedule, and manage Facebook and Instagram social content workflows",
  "Use WhatsApp approved templates for customer updates, reminders, and campaigns",
  "Route conversations to staff, trigger automations, and hand off from AI to humans",
  "Track message status, webhook events, campaign activity, and engagement reporting",
];

const dataCategories = [
  "Meta business account, Facebook Page, Instagram Business, and WhatsApp Business Account details",
  "Connected phone number, profile, page, channel, and permission information",
  "Messages, comments, replies, media metadata, templates, posts, and campaign records",
  "Delivery, read, engagement, webhook, analytics, and operational status events",
  "Dashboard user activity needed for security, support, troubleshooting, and audit history",
];

export default function MetaBusinessPlatformPage() {
  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
      <div className="bg-noise" />
      <Navbar />

      <section className="relative overflow-hidden px-6 pb-12 pt-28 md:px-12 md:pb-16 md:pt-32">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(232,160,32,0.15),transparent_38%),radial-gradient(circle_at_78%_20%,rgba(61,186,122,0.12),transparent_32%)]" />
        <div className="relative mx-auto max-w-7xl">
          <div className="grid gap-10 border-t border-border/50 pt-8 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                Meta Business Platform
              </p>
              <h1 className="mt-4 max-w-3xl font-display text-4xl leading-[0.95] tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
                Manage Meta business channels from one workspace.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground md:text-base">
                KasiTek helps businesses use WhatsApp Business, Facebook Pages, and Instagram
                Business for customer messaging, social publishing, automation, and reporting
                through official Meta business APIs.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/get-quote"
                  className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary/90"
                >
                  Request Access
                </Link>
                <Link
                  href="/privacy-policy"
                  className="rounded-lg border border-border bg-card/35 px-6 py-3 text-sm font-semibold text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/5"
                >
                  View Privacy Policy
                </Link>
              </div>
            </div>

            <div className="rounded-[22px] border border-border bg-card/60 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.28)] backdrop-blur-sm sm:p-6">
              <div className="flex items-center justify-between border-b border-border pb-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    Multi-Inbox Management
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    WhatsApp, Facebook, and Instagram conversations in one workspace
                  </p>
                </div>
                <div className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
                  Live
                </div>
              </div>
              <div className="mt-5 space-y-3">
                {[
                  ["WhatsApp", "Can I get a quote for tomorrow?"],
                  ["Facebook", "Is the Randburg branch open today?"],
                  ["Instagram", "Please send the booking link."],
                  ["Agent", "Assigned to sales. Follow-up reminder set."],
                ].map(([label, text], index) => (
                  <div
                    key={`${label}-${text}`}
                    className={`rounded-2xl border px-4 py-3 text-sm leading-relaxed ${
                      index === 3
                        ? "ml-auto max-w-[88%] rounded-br-sm border-primary/20 bg-primary/10"
                        : "max-w-[88%] rounded-bl-sm border-white/10 bg-white/[0.04]"
                    }`}
                  >
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                      {label}
                    </div>
                    {text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 md:px-12 md:py-20">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-5 md:grid-cols-3">
            {channels.map((channel) => {
              const Icon = channel.icon;
              return (
                <article key={channel.title} className="rounded-[24px] border border-border bg-card/55 p-7">
                  <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                    {channel.title}
                  </h2>
                  <p className="mt-3 text-sm leading-7 text-muted-foreground">
                    {channel.description}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-card px-6 py-16 md:px-12 md:py-24">
        <div className="mx-auto grid max-w-7xl gap-12 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              What Clients Use KasiTek For
            </p>
            <h2 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-6xl">
              Messaging, publishing, automation, and reporting.
            </h2>
            <p className="mt-5 text-base leading-8 text-muted-foreground">
              KasiTek provides the workspace layer around connected Meta channels. Clients keep
              ownership of their business accounts and grant the permissions needed to deliver the
              service.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {capabilities.map((item) => (
              <div key={item} className="flex items-start gap-3 rounded-2xl border border-white/8 bg-[#0D0D0D] p-5">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <p className="text-sm leading-6 text-muted-foreground">{item}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:px-12 md:py-24">
        <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-3">
          <div className="rounded-[24px] border border-border bg-card/55 p-7">
            <ShieldCheck className="mb-5 h-6 w-6 text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Official API Access
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              KasiTek is built for permissioned Meta integrations and official platform APIs. It is
              not based on unofficial WhatsApp Web scraping or grey-market sending tools.
            </p>
          </div>

          <div className="rounded-[24px] border border-border bg-card/55 p-7">
            <Bot className="mb-5 h-6 w-6 text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              AI With Handoff
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              AI can draft replies, answer routine questions, qualify leads, trigger workflows, and
              hand conversations to staff when a human response is needed.
            </p>
          </div>

          <div className="rounded-[24px] border border-border bg-card/55 p-7">
            <BarChart3 className="mb-5 h-6 w-6 text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Operational Visibility
            </h2>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              Teams can track delivery, engagement, campaign activity, inbox volume, automation
              outcomes, and staff handoff across connected channels.
            </p>
          </div>
        </div>
      </section>

      <section className="px-6 pb-20 md:px-12 md:pb-28">
        <div className="mx-auto max-w-7xl rounded-[32px] border border-border bg-card/55 p-8 md:p-10">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
            <div>
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                <MessagesSquare className="h-5 w-5" />
              </div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                Platform Data
              </p>
              <h2 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-5xl">
                Data is used to provide the connected service.
              </h2>
              <p className="mt-5 text-base leading-8 text-muted-foreground">
                KasiTek uses Meta platform data only to operate the workspace, inbox, publishing,
                automation, reporting, support, and security features requested by the connected
                client.
              </p>
            </div>

            <div className="space-y-3">
              {dataCategories.map((item) => (
                <div key={item} className="flex items-start gap-3 rounded-2xl border border-white/8 bg-black/20 p-4">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <p className="text-sm leading-6 text-muted-foreground">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="relative px-6 pb-28 md:px-12 md:pb-36">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(232,160,32,0.08),transparent_58%)]" />
        <div className="relative mx-auto max-w-5xl rounded-[32px] border border-border bg-card/45 px-8 py-12 text-center backdrop-blur-sm md:px-12 md:py-16">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            For Businesses and Client Teams
          </p>
          <h2 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-6xl">
            Connect the channels your customers already use.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-muted-foreground">
            Start with WhatsApp, Facebook, Instagram, or a full Meta-connected workflow. KasiTek
            can support self-serve product access, managed rollout, and custom implementation work.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
            <Link
              href="/get-quote"
              className="rounded-lg bg-primary px-8 py-4 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary/90"
            >
              Talk to KasiTek
            </Link>
            <Link
              href="/terms"
              className="rounded-lg border border-border bg-card/30 px-8 py-4 text-sm font-semibold text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/5"
            >
              View Terms
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
