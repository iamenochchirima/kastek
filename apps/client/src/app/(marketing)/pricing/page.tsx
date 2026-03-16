import type { Metadata } from "next";
import Link from "next/link";
import { Check, Zap } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

export const metadata: Metadata = {
  title: "Pricing | KasiTek",
  description: "Product and service pricing for KasiTek AI agents, marketing systems, and custom growth infrastructure.",
};

const productTiers = [
  {
    name: "Basic",
    monthly: "R999/month",
    setup: "Setup from R2,500",
    description: "For businesses starting with one core product and a lighter automation footprint.",
    features: [
      "Access to one KasiTek product workspace",
      "Core AI agent or campaign functionality",
      "Basic onboarding and setup support",
      "Single brand/business setup",
      "Standard maintenance and updates",
    ],
  },
  {
    name: "Growth",
    monthly: "R2,499/month",
    setup: "Setup from R4,500",
    featured: true,
    description: "For growing teams using multiple products and stronger automation across sales and marketing.",
    features: [
      "Access to multiple KasiTek product modules",
      "Higher usage and more active workflows",
      "Advanced setup and system tailoring",
      "Priority support",
      "Better fit for multi-channel growth",
    ],
  },
  {
    name: "Scale",
    monthly: "R4,999+/month",
    setup: "Setup from R8,500+",
    description: "For businesses that need deeper automation, more complex workflows, and heavier operational support.",
    features: [
      "Expanded product access and higher limits",
      "Multi-team or multi-workspace support",
      "Advanced routing and workflow complexity",
      "Closer optimization support",
      "Best fit for more serious automation rollouts",
    ],
  },
];

const serviceCards = [
  {
    title: "Custom AI Chatbots",
    from: "From R4,500",
    description:
      "Fully custom chatbots for WhatsApp, websites, Facebook, or Instagram with your business logic, tone, and escalation rules.",
  },
  {
    title: "Voice Agents",
    from: "From R8,500",
    description:
      "AI voice agents for inbound calls, appointment booking, screening, FAQs, and call routing built around your real scripts.",
  },
  {
    title: "Growth Workflows",
    from: "From R3,500",
    description:
      "Lead capture, follow-up, reactivation, quoting, and sales automation workflows built around your actual conversion process.",
  },
  {
    title: "System Integrations",
    from: "From R5,000",
    description:
      "Connect your agent or workflows to CRMs, sheets, booking tools, calendars, POS systems, and internal platforms.",
  },
  {
    title: "Digital Infrastructure",
    from: "From R6,500",
    description:
      "Landing pages, websites, dashboards, and web tools that support the systems behind your AI and automation rollout.",
  },
  {
    title: "Managed Retainers",
    from: "Custom Quote",
    description:
      "Ongoing management, optimization, reporting, and system expansion once your automation stack is already live.",
  },
];

export default function PricingPage() {
  return (
    <main className="relative min-h-screen w-full selection:bg-primary/30 selection:text-primary">
      <div className="bg-noise" />
      <Navbar />

      <section
        id="home"
        className="relative overflow-hidden px-6 pb-16 pt-32 md:px-12 md:pb-24 md:pt-40"
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(232,160,32,0.12),transparent_42%)]" />
        <div className="relative mx-auto max-w-7xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1.5 shadow-sm backdrop-blur-sm">
            <Zap className="h-3.5 w-3.5 text-primary" fill="currentColor" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Pricing
            </span>
          </div>

          <div className="mt-8 grid gap-12 border-t border-border/50 pt-8 lg:grid-cols-[minmax(0,1.3fr)_360px] lg:items-end">
            <div>
              <h1 className="font-display text-5xl leading-[0.9] tracking-tight text-foreground sm:text-6xl md:text-8xl">
                Clear pricing for <span className="text-primary">products</span>, flexible pricing for services.
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
                Self-serve products should have cleaner monthly pricing. Bespoke services should
                stay flexible, with starting ranges that help people understand budget expectations.
              </p>
            </div>

            <div className="rounded-[28px] border border-border bg-card/60 p-6 backdrop-blur-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                How to read this page
              </p>
              <div className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
                <p>Setup covers implementation, configuration, and initial deployment.</p>
                <p>Monthly pricing covers hosting, maintenance, and product support.</p>
                <p>More advanced or bundled work is scoped as a tailored quote.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="products" className="px-6 py-10 md:px-12 md:py-16">
        <div className="mx-auto max-w-7xl space-y-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              Products
            </p>
            <h2 className="mt-3 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-6xl">
              Subscription Services.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground md:text-lg">
              Monthly subscriptions for KasiTek products like KasiAgents, KasiReach, and
              KasiSocial.
            </p>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            {productTiers.map((tier) => (
              <div
                key={tier.name}
                className={`relative overflow-hidden rounded-[28px] border p-7 ${
                  tier.featured
                    ? "border-primary/35 bg-[linear-gradient(180deg,rgba(232,160,32,0.16),rgba(255,255,255,0.03)_32%,rgba(255,255,255,0.02)_100%)] shadow-[0_0_40px_rgba(232,160,32,0.08)]"
                    : "border-border bg-card/55"
                }`}
              >
                {tier.featured ? (
                  <div className="absolute right-5 top-5 rounded-full border border-primary/20 bg-primary/12 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                    Recommended
                  </div>
                ) : null}

                <div className="space-y-3">
                  <h3 className="text-2xl font-semibold tracking-tight text-foreground">
                    {tier.name}
                  </h3>
                  <div className="text-4xl font-semibold tracking-tight text-foreground">
                    {tier.monthly}
                  </div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    {tier.setup}
                  </p>
                  <p className="text-sm leading-6 text-muted-foreground">{tier.description}</p>
                </div>

                <div className="my-7 h-px bg-border/70" />

                <div className="space-y-4">
                  {tier.features.map((feature) => (
                    <div key={feature} className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-full border border-primary/20 bg-primary/10 p-1">
                        <Check className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <p className="text-sm leading-6 text-muted-foreground">{feature}</p>
                    </div>
                  ))}
                </div>

                <div className="mt-8">
                  <Link
                    href={`/get-quote?service=${encodeURIComponent(`${tier.name} Product Plan`)}`}
                    className="inline-flex rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary/90"
                  >
                    Get Started
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="services" className="px-6 py-10 md:px-12 md:py-16">
        <div className="mx-auto max-w-7xl space-y-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              Services
            </p>
            <h2 className="mt-3 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-6xl">
              Custom Services.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground md:text-lg">
              Custom chatbots, voice agents, growth workflows, system integrations, and other
              tailored work are priced by quote. We show starting ranges to help you understand the
              likely budget.
            </p>
          </div>

          <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
            {serviceCards.map((service) => (
              <div key={service.title} className="rounded-[28px] border border-border bg-card/55 p-7">
                <div className="space-y-3">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                    {service.from}
                  </p>
                  <h3 className="text-2xl font-semibold tracking-tight text-foreground">
                    {service.title}
                  </h3>
                  <p className="text-sm leading-7 text-muted-foreground">
                    {service.description}
                  </p>
                </div>

                <div className="mt-8">
                  <Link
                    href={`/get-quote?service=${encodeURIComponent(service.title)}`}
                    className="inline-flex rounded-lg border border-border bg-card/40 px-5 py-3 text-sm font-semibold text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/5"
                  >
                    Request Quote
                  </Link>
                </div>
              </div>
            ))}
          </div>

        </div>
      </section>

      <section id="contact" className="relative px-6 pb-28 pt-14 md:px-12 md:pb-36">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(232,160,32,0.08),transparent_58%)]" />
        <div className="relative mx-auto max-w-5xl rounded-[36px] border border-border bg-card/45 px-8 py-12 text-center backdrop-blur-sm md:px-12 md:py-16">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            Ready to Start
          </p>
          <h2 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-foreground md:text-6xl">
            Move from pricing to a real rollout plan.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-muted-foreground">
            If you already know the direction, the next step is turning it into a scoped setup,
            timeline, and rollout recommendation.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
            <Link
              href="/get-quote"
              className="rounded-lg bg-primary px-8 py-4 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-primary/90"
            >
              Request a Quote
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-border bg-card/30 px-8 py-4 text-sm font-semibold text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/5"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
