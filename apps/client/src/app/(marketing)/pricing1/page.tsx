import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Pricing 1 | KasiTek",
  description:
    "Pricing for web presence, AI agents, and growth systems.",
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
        name: "Website Assistant",
        price: "R3,500",
        meta: "Setup",
        items: ["Website chat assistant", "Knowledge base setup", "FAQ and enquiry handling"],
      },
      {
        name: "Monthly Support",
        price: "R300/month",
        meta: "Monthly",
        items: ["Hosting", "Monitoring", "Minor updates"],
      },
      {
        name: "WhatsApp or Multi-Channel",
        price: "Custom quote",
        meta: "Quoted",
        items: ["Channel-dependent setup", "Platform-based scope", "Quoted per workflow"],
      },
    ],
  },
  {
    id: "growth-systems",
    title: "Growth Systems",
    cards: [
      {
        name: "Lead Capture Automation",
        price: "From R2,500",
        meta: "Setup",
        items: ["Lead intake flow", "Basic follow-up logic", "Automation setup"],
      },
      {
        name: "Managed Growth Support",
        price: "R300/month",
        meta: "Monthly",
        items: ["Routine updates", "System support", "Light optimisation"],
      },
      {
        name: "WhatsApp Marketing",
        price: "Custom quote",
        meta: "Quoted",
        items: ["Campaign workflows", "Messaging setup", "Platform-dependent pricing"],
      },
    ],
  },
];

export default function PricingDraftPage() {
  return (
    <>
      <Navbar />

      <main className="min-h-screen bg-bg pt-24 text-text">
        <section className="relative overflow-hidden border-b border-border">
          <div className="absolute inset-0" style={{ backgroundImage: "var(--theme-hero-aura)" }} />
          <div className="absolute left-12 top-16 h-44 w-44 rounded-full border border-border" />
          <div className="absolute right-[-60px] top-20 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />

          <div className="relative mx-auto max-w-7xl px-6 pb-20 pt-10 md:px-10 md:pb-24">
            <div className="max-w-4xl">
              <div className="inline-flex rounded-full border border-accent/30 bg-accent/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Pricing 1
              </div>

              <h1 className="mt-6 text-5xl font-black uppercase leading-[0.94] tracking-[-0.05em] md:text-7xl">
                Pricing for websites,
                <br />
                AI agents,
                <br />
                <span className="text-accent">and growth systems.</span>
              </h1>

              <div className="mt-10 flex flex-wrap gap-4">
                <Link
                  href="/get-quote"
                  className="rounded-full bg-accent px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-bg transition hover:-translate-y-0.5"
                >
                  Get a Quote
                </Link>
                <a
                  href="#web-presence"
                  className="rounded-full border border-border px-7 py-3 text-sm font-bold uppercase tracking-[0.12em] text-text transition hover:border-accent/50 hover:text-accent"
                >
                  View Pricing
                </a>
              </div>
            </div>
          </div>
        </section>

        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="mx-auto max-w-7xl px-6 py-18 md:px-10 md:py-20"
          >
            <div className="mb-8">
              <h2 className="text-4xl font-black uppercase leading-[0.95] tracking-[-0.04em]">
                {section.title}
              </h2>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              {section.cards.map((card) => (
                <div
                  key={card.name}
                  className="rounded-[2rem] border border-border bg-surface p-8"
                >
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
