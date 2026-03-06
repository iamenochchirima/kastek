import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Pricing | KasiTek",
  description: "Pricing for web presence, AI agents, and growth systems.",
};

const sections = [
  {
    id: "web-presence",
    title: "Web Presence",
    cards: [
      {
        name: "Landing Page",
        price: "From R2,000",
        meta: "Once-off",
        items: ["Single-page build", "Lead capture section", "Mobile-friendly layout"],
      },
      {
        name: "Business Website",
        price: "From R3,500",
        meta: "Once-off",
        items: ["Multi-section website", "Core business pages", "Conversion-focused structure"],
      },
      {
        name: "Website Redesign",
        price: "Custom quote",
        meta: "Quoted",
        items: ["Design refresh", "Structure improvements", "Scope-based pricing"],
      },
    ],
  },
  {
    id: "ai-agents",
    title: "AI Agents",
    cards: [
      {
        name: "Starter",
        price: "Setup from R2,500",
        meta: "R300/month",
        items: [
          "Basic FAQ and enquiry handling",
          "Lead capture flow",
          "Knowledge base setup",
          "Single channel (website or WhatsApp)",
          "Basic human handover",
        ],
      },
      {
        name: "Growth",
        price: "Setup from R4,500",
        meta: "R750/month",
        items: [
          "Everything in Starter",
          "Multi-step lead qualification",
          "Structured lead capture",
          "Simple integrations (sheet/CRM)",
          "Priority support",
        ],
      },
      {
        name: "Scale",
        price: "Setup: R8,500+",
        meta: "R1,500+/month",
        items: [
          "Everything in Growth",
          "Advanced routing and escalation",
          "Multi-channel and inbox workflows",
          "Deeper integrations and automations",
          "Ongoing optimization support",
        ],
      },
    ],
  },
  {
    id: "growth-systems",
    title: "Growth Systems",
    cards: [
      {
        name: "Bulk WhatsApp Campaigns",
        price: "Setup from R3,500",
        meta: "R350/month",
        items: [
          "Audience segmentation setup",
          "Template campaign setup",
          "Broadcast workflow setup",
          "Basic campaign tracking",
          "Meta usage fees billed separately",
        ],
      },
      {
        name: "Lead Follow-Up Automation",
        price: "Setup from R2,500",
        meta: "R500/month",
        items: [
          "Instant lead acknowledgement",
          "Follow-up sequences (WhatsApp/email)",
          "Missed-lead recovery flows",
          "Basic CRM or sheet syncing",
        ],
      },
      {
        name: "Reactivation & Retention",
        price: "Setup from R4,000",
        meta: "R750/month",
        items: [
          "Win-back campaigns for old clients",
          "Reminder flows (appointments/payments/check-ins)",
          "Repeat-purchase nudges",
          "Customer lifecycle messaging",
        ],
      },
    ],
  },
];

export default function PricingPage() {
  return (
    <>
      <Navbar />

      <main className="min-h-screen bg-bg text-text">
        <section className="mx-auto max-w-7xl px-6 pb-6 pt-10 text-center md:px-10">
          <h1 className="text-4xl font-black uppercase tracking-[-0.03em] md:text-5xl">
            Pricing Plans
          </h1>
          <p className="mx-auto mt-3 max-w-3xl text-base text-text-muted">
            Clear starting prices for web presence, AI agents, and growth systems.
          </p>
        </section>

        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="mx-auto max-w-7xl px-6 py-16 md:px-10 md:py-18"
          >
            <div className="mb-8">
              <h2 className="text-4xl font-black uppercase leading-[0.95] tracking-[-0.04em]">
                {section.title}
              </h2>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              {section.cards.map((card) => (
                <div key={card.name} className="rounded-[2rem] border border-border bg-surface p-8">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-2xl font-black uppercase">{card.name}</h3>
                      <p className="mt-2 text-sm uppercase tracking-[0.16em] text-text-muted">
                        {card.meta}
                      </p>
                    </div>
                    <div className="text-right text-lg font-black text-accent">{card.price}</div>
                  </div>

                  <div className="my-8 h-px bg-border" />

                  <div className="space-y-4">
                    {card.items.map((item) => (
                      <div key={item} className="text-sm leading-7 text-text">
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="mx-auto max-w-7xl px-6 pb-20 md:px-10">
          <div className="rounded-[2rem] border border-accent/35 bg-[linear-gradient(135deg,rgba(196,240,77,0.16),rgba(196,240,77,0.04)_28%,rgba(255,255,255,0.02)_100%)] p-8">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <h2 className="text-3xl font-black uppercase leading-[0.95]">
                  Need exact pricing for your business?
                </h2>
                <p className="mt-4 text-base leading-8 text-text">
                  More advanced, bundled, or platform-dependent work is best handled through a
                  tailored quote.
                </p>
              </div>

              <div className="flex flex-wrap gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-text px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-bg transition hover:-translate-y-0.5"
                >
                  Request a Quote
                </Link>
                <a
                  href="https://wa.me/27731231909?text=Hi%20KasiTek%2C%20I%27d%20like%20help%20with%20pricing"
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-border px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-text transition hover:bg-surface"
                >
                  Chat on WhatsApp
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
