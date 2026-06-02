"use client";

import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Bot,
  CheckCircle2,
  Megaphone,
  MessagesSquare,
  PhoneCall,
  Sparkles,
  Wand2,
} from "lucide-react";

type Product = {
  title: string;
  description: string;
  points: string[];
  cta: string;
  icon: ComponentType<{ className?: string }>;
  status: string;
  tone: "primary" | "accent" | "neutral";
  demo: ReactNode;
};

const products: Product[] = [
  {
    title: "Customer Conversation AI",
    description:
      "Turn customer conversations into bookings, quotations, and qualified opportunities.",
    points: [
      "Website, WhatsApp, Facebook, and Instagram agents that respond in real time",
      "Booking flows for appointments, enquiries, and service requests",
      "WhatsApp catalogue journeys for product discovery and ordering",
      "Automated quotation creation for qualifying jobs and service requests",
      "Voice agents for after-hours calls, FAQs, and call routing",
      "Smart handoff into your team, inbox, or booking workflow",
    ],
    cta: "/solutions",
    icon: MessagesSquare,
    status: "Live demos",
    tone: "primary",
    demo: <ConversationDemo />,
  },
  {
    title: "Growth Automation",
    description:
      "Keep every lead warm, every follow-up on time, and every client visible.",
    points: [
      "Automated lead nurturing across WhatsApp, email, and reminder flows",
      "Appointment reminders, reactivation, and follow-up sequences",
      "Review automation that drives happy customers to public reviews and captures issues internally",
      "Campaign, routing, and conversion workflows tied to your sales process",
      "Branded dashboards and reporting for teams, clients, or partner delivery",
    ],
    cta: "/solutions",
    icon: Megaphone,
    status: "Configured around your flow",
    tone: "accent",
    demo: <AutomationDemo />,
  },
  {
    title: "Social Media Management Systems",
    description:
      "Plan, publish, reply, and report across WhatsApp, Facebook, Instagram, LinkedIn, X, and other customer channels.",
    points: [
      "Social inbox for WhatsApp, Facebook Page, and Instagram customer messages",
      "Content planning and publishing workflows for Facebook, Instagram, LinkedIn, X, and campaign posts",
      "WhatsApp templates, broadcasts, and campaign status tracking where approved",
      "Campaign calendars, message history, and reporting inside one business dashboard",
      "Built for permissioned business accounts and official platform integrations",
    ],
    cta: "/solutions",
    icon: Wand2,
    status: "Multi-channel management",
    tone: "neutral",
    demo: <SocialManagementDemo />,
  },
];

const toneClasses = {
  primary: {
    icon: "border-primary/20 bg-primary/10 text-primary",
    badge: "border-primary/20 bg-primary/10 text-primary",
    check: "text-primary",
  },
  accent: {
    icon: "border-accent/20 bg-accent/10 text-accent",
    badge: "border-accent/20 bg-accent/10 text-accent",
    check: "text-accent",
  },
  neutral: {
    icon: "border-white/10 bg-white/5 text-foreground",
    badge: "border-white/10 bg-white/5 text-muted-foreground",
    check: "text-foreground",
  },
};

export function Products() {
  return (
    <section className="px-6 py-20 md:px-12 md:py-32" id="products">
      <div className="mx-auto max-w-7xl">
        <div className="mb-14 text-center md:mb-24">
          <div>
            <p className="mb-4 text-base font-semibold uppercase tracking-[0.2em] text-primary">
              Products
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {products.map((product, index) => {
            const tone = toneClasses[product.tone];
            const Icon = product.icon;
            const reverse = index % 2 === 1;

            return (
              <motion.div
                key={product.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.45, delay: index * 0.06 }}
                className="relative overflow-hidden rounded-2xl border border-border bg-[#0D0D0D] p-6 sm:p-8 md:p-10 lg:p-12"
              >
                <div className="pointer-events-none absolute inset-y-0 right-0 w-1/3 bg-[radial-gradient(circle_at_top_right,rgba(232,160,32,0.08),transparent_65%)]" />
                <div
                  className={`grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-16 ${
                    reverse ? "lg:[&>*:first-child]:order-2 lg:[&>*:last-child]:order-1" : ""
                  }`}
                >
                  <div className="relative z-10 flex flex-col">
                    <div className="mb-7 flex items-center gap-3">
                      <div
                        className={`flex h-12 w-12 items-center justify-center rounded-xl border ${tone.icon}`}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      <div
                        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${tone.badge}`}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {product.status}
                      </div>
                    </div>

                    <h3 className="mb-4 font-display text-4xl leading-none md:text-5xl">
                      {product.title}
                    </h3>

                    <p className="mb-8 max-w-xl leading-relaxed text-muted-foreground">
                      {product.description}
                    </p>

                    <ul className="mb-10 flex flex-col gap-3">
                      {product.points.map((point) => (
                        <li key={point} className="flex items-start gap-3 text-sm text-muted-foreground">
                          <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${tone.check}`} />
                          <span>{point}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-auto">
                      <Link
                        href={product.cta}
                        className="inline-flex items-center rounded-lg border border-primary/20 bg-primary/10 px-5 py-2.5 font-semibold text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                      >
                        Explore Solutions &rarr;
                      </Link>
                    </div>
                  </div>

                  <div className="relative z-10">{product.demo}</div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ConversationDemo() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40 sm:p-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Live conversation
          </p>
          <p className="mt-2 text-sm text-foreground">Website, WhatsApp, and voice working together</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
          Active
        </div>
      </div>

      <div className="mt-5 space-y-3">
        {[
          { side: "left", label: "Website", text: "Can I book for Friday morning?" },
          { side: "right", label: "Agent", text: "Yes. I have 9am or 11am open. Which suits you?" },
          { side: "left", label: "WhatsApp", text: "9am works. I am in Randburg." },
          { side: "right", label: "Agent", text: "Booked. I have sent your confirmation and notified the team." },
        ].map((message, index) => (
          <motion.div
            key={index}
            initial={{ opacity: 0.4, x: message.side === "left" ? -10 : 10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: index * 0.08 }}
            className={`flex ${message.side === "right" ? "justify-end" : ""}`}
          >
            <div
              className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                message.side === "right"
                  ? "rounded-br-sm border border-primary/20 bg-primary/10 text-foreground"
                  : "rounded-bl-sm border border-white/10 bg-white/5 text-foreground"
              }`}
            >
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {message.label}
              </div>
              {message.text}
            </div>
          </motion.div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4">
        {[
          { label: "Reply time", value: "< 10s" },
          { label: "Channels", value: "4" },
          { label: "Escalations", value: "Smart" },
        ].map((item) => (
          <div key={item.label} className="rounded-xl border border-white/8 bg-white/[0.03] p-3 text-center">
            <div className="font-display text-2xl leading-none text-primary">{item.value}</div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {item.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomationDemo() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40 sm:p-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Workflow engine
          </p>
          <p className="mt-2 text-sm text-foreground">Lead capture to conversion with no dead space</p>
        </div>
        <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
          Automation live
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {[
          { icon: Bot, title: "Lead Captured", detail: "Meta ad form submitted for kitchen renovation quote" },
          { icon: MessagesSquare, title: "Instant Follow-Up", detail: "WhatsApp sent in 6 seconds with qualification prompts" },
          { icon: PhoneCall, title: "Team Alert", detail: "Sales rep assigned and notified for hot lead handoff" },
          { icon: Sparkles, title: "Conversion Update", detail: "Booking confirmed and dashboard status moved to won" },
        ].map((step, index) => {
          const Icon = step.icon;
          return (
            <motion.div
              key={step.title}
              initial={{ opacity: 0.45, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.35, delay: index * 0.08 }}
              className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-accent">
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <div className="text-sm font-semibold text-foreground">{step.title}</div>
                <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.detail}</div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SocialManagementDemo() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40 sm:p-6">
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Social channels
          </p>
          <p className="mt-2 text-sm text-foreground">Posts, messages, campaigns, and reporting in one workflow</p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
          <Wand2 className="h-3.5 w-3.5" />
          Multi-channel
        </div>
      </div>

      <div className="mt-5 rounded-xl border border-white/8 bg-white/[0.03] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Campaign workspace
            </div>
            <div className="mt-2 text-sm leading-relaxed text-foreground">
              Plan a promotion, publish across social channels, follow up on WhatsApp, and track replies.
            </div>
          </div>
          <div className="rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary">
            Schedule
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {[
          { label: "WhatsApp", status: "Campaign ready" },
          { label: "Instagram", status: "Inbox active" },
          { label: "Facebook Page", status: "Page connected" },
          { label: "LinkedIn", status: "Post scheduled" },
          { label: "X", status: "Thread queued" },
          { label: "Reports", status: "Live metrics" },
        ].map((item, index) => (
          <motion.div
            key={item.label}
            initial={{ opacity: 0.4, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.35, delay: index * 0.07 }}
            className="rounded-xl border border-white/8 bg-white/[0.03] p-4"
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {item.label}
            </div>
            <div className="mt-2 text-sm font-semibold text-foreground">{item.status}</div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
