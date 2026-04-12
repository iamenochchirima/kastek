"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Bot,
  CheckCircle2,
  MessagesSquare,
  PhoneCall,
  Sparkles,
  Wand2,
} from "lucide-react";
import type { SolutionDemoKind, SolutionService } from "@/app/(marketing)/solutions/data";

export function SolutionServicesShowcase({
  eyebrow,
  title,
  description,
  services,
}: {
  eyebrow: string;
  title: string;
  description: string;
  services: SolutionService[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeService = services[activeIndex];

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-6 md:p-8">
        <p className="mb-3 text-sm font-semibold uppercase tracking-[0.22em] text-primary">
          {eyebrow}
        </p>
        <h2 className="font-display text-3xl leading-none text-foreground md:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground md:text-base">
          {description}
        </p>

        <div className="mt-8 space-y-3">
          {services.map((service, index) => {
            const active = index === activeIndex;
            return (
              <button
                key={service.title}
                type="button"
                onClick={() => setActiveIndex(index)}
                className={`w-full rounded-2xl border px-4 py-4 text-left transition ${
                  active
                    ? "border-primary/30 bg-primary/10 text-foreground"
                    : "border-white/8 bg-white/[0.03] text-foreground hover:border-white/14 hover:bg-white/[0.05]"
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-base font-semibold">{service.title}</div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      {service.description}
                    </p>
                  </div>
                  {active ? (
                    <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                      Active
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-2xl border border-white/8 bg-[#0D0D0D] p-6 md:p-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Service Demo
            </p>
            <h3 className="mt-3 font-display text-3xl leading-none text-foreground">
              {activeService.title}
            </h3>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
              {activeService.description}
            </p>
          </div>
          <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
            Preview
          </div>
        </div>

        {renderDemo(activeService.demoKind)}

        <div className="mt-6 flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-sm leading-relaxed text-muted-foreground">
            The service panel on the left lets visitors scan the full category offer
            while the right side keeps one concrete example in focus.
          </p>
        </div>
      </div>
    </section>
  );
}

function renderDemo(kind: SolutionDemoKind) {
  switch (kind) {
    case "website-agent":
    case "whatsapp-agent":
    case "catalogue-agent":
      return <ConversationDemo variant={kind} />;
    case "quote-automation":
      return <QuoteDemo />;
    case "voice-agent":
      return <VoiceDemo />;
    case "lead-nurturing":
    case "reviews":
      return <FlowDemo variant={kind} />;
    case "reporting":
    case "usage-reporting":
      return <ReportingDemo />;
    case "content-engine":
    case "aeo":
      return <ContentDemo variant={kind} />;
    case "platform-embed":
    case "tenant-provisioning":
      return <PlatformDemo variant={kind} />;
    case "coming-soon":
      return <ComingSoonDemo />;
    default:
      return <ComingSoonDemo />;
  }
}

function ConversationDemo({
  variant,
}: {
  variant: "website-agent" | "whatsapp-agent" | "catalogue-agent";
}) {
  const conversationMap = {
    "website-agent": {
      label: "Website Agent",
      messages: [
        ["Visitor", "Do you install prepaid meters in Midrand?"],
        ["Agent", "Yes. Residential or commercial property?"],
        ["Visitor", "Residential, 3-bedroom home."],
        ["Agent", "Got it. I can send a quote request to the team right now."],
      ],
    },
    "whatsapp-agent": {
      label: "WhatsApp Agent",
      messages: [
        ["Customer", "Can I book for tomorrow morning?"],
        ["Agent", "Yes. I have 9am and 11am open."],
        ["Customer", "9am works."],
        ["Agent", "Booked. I’ve sent your confirmation."],
      ],
    },
    "catalogue-agent": {
      label: "WhatsApp Catalogue",
      messages: [
        ["Customer", "Show me your solar batteries under R10k"],
        ["Agent", "I found 3 options. Want 5kWh or 10kWh?"],
        ["Customer", "5kWh."],
        ["Agent", "This one is in stock. I can add it to your quote."],
      ],
    },
  } as const;

  const config = conversationMap[variant];

  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            {config.label}
          </p>
          <p className="mt-2 text-sm text-foreground">Customer conversation in motion</p>
        </div>
        <div className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
          Active
        </div>
      </div>

      <div className="space-y-3">
        {config.messages.map(([sender, message], index) => {
          const reply = index % 2 === 1;
          return (
            <motion.div
              key={`${sender}-${index}`}
              initial={{ opacity: 0.45, x: reply ? 10 : -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.3, delay: index * 0.06 }}
              className={`flex ${reply ? "justify-end" : ""}`}
            >
              <div
                className={`max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  reply
                    ? "rounded-br-sm border border-primary/20 bg-primary/10 text-foreground"
                    : "rounded-bl-sm border border-white/10 bg-white/5 text-foreground"
                }`}
              >
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {sender}
                </div>
                {message}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function QuoteDemo() {
  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Quotation Flow
          </p>
          <p className="mt-2 text-sm text-foreground">From customer request to ready quote</p>
        </div>
        <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
          Automated
        </div>
      </div>

      <div className="space-y-3">
        {[
          "Customer request received from WhatsApp",
          "Job details extracted and matched to pricing rules",
          "Line items added and totals calculated",
          "Quote generated and sent for review or delivery",
        ].map((step, index) => (
          <div key={step} className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-sm font-semibold text-primary">
                {index + 1}
              </div>
              <p className="text-sm leading-relaxed text-foreground/90">{step}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VoiceDemo() {
  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Voice Agent
          </p>
          <p className="mt-2 text-sm text-foreground">Call handling after hours and at peak load</p>
        </div>
        <div className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
          Live call
        </div>
      </div>

      <div className="flex flex-col items-center gap-5 py-8">
        <div className="relative flex items-center justify-center">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="absolute animate-ping rounded-full border border-primary/20"
              style={{
                width: `${64 + index * 26}px`,
                height: `${64 + index * 26}px`,
                animationDelay: `${index * 0.35}s`,
                animationDuration: "1.8s",
              }}
            />
          ))}
          <div className="relative z-10 flex h-16 w-16 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-primary">
            <PhoneCall className="h-6 w-6" />
          </div>
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">+27 11 555 0100</p>
          <p className="mt-1 text-sm text-muted-foreground">FAQ, booking, routing, and escalation</p>
        </div>
      </div>
    </div>
  );
}

function FlowDemo({ variant }: { variant: "lead-nurturing" | "reviews" }) {
  const items =
    variant === "reviews"
      ? [
          "Service completed",
          "Review request sent automatically",
          "Positive response routed to public review link",
          "Negative response captured privately for recovery",
        ]
      : [
          "Lead captured",
          "Instant follow-up triggered",
          "Reminder and reactivation messages scheduled",
          "Status updated for the team automatically",
        ];

  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Workflow Preview
          </p>
          <p className="mt-2 text-sm text-foreground">
            {variant === "reviews" ? "Review automation loop" : "Lead nurturing sequence"}
          </p>
        </div>
        <div className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
          Automated
        </div>
      </div>
      <div className="space-y-3">
        {items.map((item, index) => (
          <div key={item} className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
            <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="text-sm leading-relaxed text-foreground/90">
              <span className="font-semibold text-foreground">Step {index + 1}:</span> {item}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportingDemo() {
  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Reporting
          </p>
          <p className="mt-2 text-sm text-foreground">Visibility for teams, clients, and operators</p>
        </div>
        <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold text-muted-foreground">
          Live data
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          ["Qualified leads", "128"],
          ["Reply rate", "91%"],
          ["Booked", "37"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-center">
            <div className="font-display text-3xl leading-none text-primary">{value}</div>
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {label}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-xl border border-white/8 bg-white/[0.03] p-4">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Dashboards can be internal, client-facing, or partner-facing depending on the delivery model.
        </p>
      </div>
    </div>
  );
}

function ContentDemo({ variant }: { variant: "content-engine" | "aeo" }) {
  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Content Studio
          </p>
          <p className="mt-2 text-sm text-foreground">
            {variant === "aeo" ? "Content structured for AI answers" : "Campaign assets queued and ready"}
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
          <Wand2 className="h-3.5 w-3.5" />
          AI-assisted
        </div>
      </div>
      <div className="space-y-3">
        {[
          "Blog draft generated from campaign brief",
          "Social and ad variations created for the same offer",
          variant === "aeo"
            ? "Structured answer blocks and citation-ready copy prepared"
            : "Publishing and approval flow queued for the team",
        ].map((item) => (
          <div key={item} className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-sm leading-relaxed text-foreground/90">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlatformDemo({
  variant,
}: {
  variant: "platform-embed" | "tenant-provisioning";
}) {
  return (
    <div className="rounded-2xl border border-white/8 bg-card p-5">
      <div className="mb-4 flex items-center justify-between border-b border-border pb-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            Platform Layer
          </p>
          <p className="mt-2 text-sm text-foreground">
            {variant === "tenant-provisioning" ? "Provisioning and rollout logic" : "Embedded customer-facing experience"}
          </p>
        </div>
        <div className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold text-accent">
          Configurable
        </div>
      </div>
      <div className="space-y-3">
        {[
          "Brand, permissions, and setup flow defined per customer type",
          "Feature access and rollout controlled from one operational layer",
          "Reporting and support data connected to the product experience",
        ].map((item) => (
          <div key={item} className="flex items-start gap-3 rounded-xl border border-white/8 bg-white/[0.03] p-4">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <p className="text-sm leading-relaxed text-foreground/90">{item}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ComingSoonDemo() {
  return (
    <div className="rounded-2xl border border-dashed border-white/12 bg-card p-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="mt-5 font-display text-3xl leading-none text-foreground">Coming Soon</h3>
      <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
        This category is still being shaped. The final solution demos will land here once the rollout model is locked.
      </p>
    </div>
  );
}
