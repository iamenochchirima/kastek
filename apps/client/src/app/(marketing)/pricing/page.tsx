import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing | KasiTek",
  description:
    "Transparent, tiered pricing for AI WhatsApp chatbots, website agents, voice agents, and custom automations.",
};

const services = [
  {
    icon: "💬",
    name: "AI WhatsApp Chatbot",
    description:
      "An AI assistant on your WhatsApp that handles customer queries, bookings, and lead capture around the clock.",
    tiers: [
      {
        tier: "Basic",
        setup: "R1,500 – R3,000",
        monthly: "R150 – R300/mo",
        features: [
          "AI-powered FAQ responses",
          "Business hours auto-responder",
          "Basic lead capture & notifications",
          "Knowledge base from your info",
          "Email support",
        ],
        ideal: "Small businesses needing 24/7 customer support",
      },
      {
        tier: "Standard",
        setup: "R3,000 – R5,000",
        monthly: "R300 – R500/mo",
        features: [
          "Everything in Basic",
          "Lead qualification forms",
          "Automated follow-up messages",
          "Multi-flow conversations",
          "Basic CRM integration",
          "Priority support",
        ],
        ideal: "Growing businesses with active lead pipelines",
      },
      {
        tier: "Advanced",
        setup: "R5,000 – R8,000",
        monthly: "R500 – R800/mo",
        features: [
          "Everything in Standard",
          "Full CRM integration",
          "Appointment & booking system",
          "Payment reminders & invoicing",
          "Custom multi-step workflows",
          "Dedicated account manager",
        ],
        ideal: "Businesses needing end-to-end automation",
      },
    ],
  },
  {
    icon: "🌐",
    name: "AI Website Agent",
    description:
      "A smart chat widget on your website that engages visitors, answers questions, and converts them into leads.",
    tiers: [
      {
        tier: "Basic",
        setup: "R1,500 – R3,000",
        monthly: "R150 – R300/mo",
        features: [
          "AI chat widget on your site",
          "FAQ & product/service Q&A",
          "Basic lead capture",
          "Branded to match your site",
          "Email support",
        ],
        ideal: "Businesses wanting instant website engagement",
      },
      {
        tier: "Standard",
        setup: "R3,000 – R5,000",
        monthly: "R300 – R500/mo",
        features: [
          "Everything in Basic",
          "Lead qualification flows",
          "Product recommendations",
          "Multi-page context awareness",
          "Basic CRM integration",
          "Priority support",
        ],
        ideal: "E-commerce and service businesses with complex offerings",
      },
      {
        tier: "Advanced",
        setup: "R5,000 – R8,000",
        monthly: "R500 – R800/mo",
        features: [
          "Everything in Standard",
          "Full CRM integration",
          "Custom actions & triggers",
          "Booking & scheduling integration",
          "Multi-step guided flows",
          "Dedicated account manager",
        ],
        ideal: "High-traffic sites needing full automation",
      },
    ],
  },
  {
    icon: "📞",
    name: "AI Voice Agent",
    description:
      "An AI receptionist that answers calls, qualifies leads, and books appointments in a natural, human-like voice.",
    tiers: [
      {
        tier: "Basic",
        setup: "R3,000 – R5,000",
        monthly: "R300 – R500/mo",
        features: [
          "Inbound call handling",
          "After-hours AI reception",
          "Message taking & forwarding",
          "Basic call scripts",
          "Email support",
        ],
        ideal: "Businesses missing calls after hours",
      },
      {
        tier: "Standard",
        setup: "R5,000 – R7,000",
        monthly: "R500 – R700/mo",
        features: [
          "Everything in Basic",
          "Smart call routing",
          "Appointment booking",
          "Appointment reminders",
          "Payment follow-ups",
          "Priority support",
        ],
        ideal: "Service businesses with high call volume",
      },
      {
        tier: "Advanced",
        setup: "R7,000 – R10,000",
        monthly: "R700 – R1,000/mo",
        features: [
          "Everything in Standard",
          "Multi-department routing",
          "Full CRM integration",
          "Call analytics & reporting",
          "Custom voice & scripts",
          "Dedicated account manager",
        ],
        ideal: "Call centres and multi-location businesses",
      },
    ],
  },
  {
    icon: "⚡",
    name: "Custom AI Workflows",
    description:
      "Purpose-built automations that connect your tools and eliminate repetitive admin work.",
    tiers: [
      {
        tier: "Basic",
        setup: "R2,000 – R4,000",
        monthly: "R200 – R400/mo",
        features: [
          "Single workflow automation",
          "Connect 2–3 tools",
          "Basic triggers & actions",
          "Email notifications",
          "Email support",
        ],
        ideal: "Automating one specific repetitive task",
      },
      {
        tier: "Standard",
        setup: "R4,000 – R6,000",
        monthly: "R400 – R600/mo",
        features: [
          "Everything in Basic",
          "Multi-step workflows",
          "Connect 4–6 tools",
          "Conditional logic & branching",
          "Error handling & retries",
          "Priority support",
        ],
        ideal: "Automating entire business processes",
      },
      {
        tier: "Advanced",
        setup: "R6,000 – R10,000",
        monthly: "R600 – R1,000/mo",
        features: [
          "Everything in Standard",
          "Complex multi-workflow systems",
          "AI-powered decision making",
          "Custom integrations & APIs",
          "Analytics dashboard",
          "Dedicated account manager",
        ],
        ideal: "Full business automation suites",
      },
    ],
  },
];

const TIER_STYLES: Record<string, { border: string; badge: string }> = {
  Basic: {
    border: "border-border",
    badge: "bg-white/[0.06] text-text-muted",
  },
  Standard: {
    border: "border-accent/30",
    badge: "bg-accent/10 text-accent",
  },
  Advanced: {
    border: "border-warm/30",
    badge: "bg-warm/10 text-warm",
  },
};

export default function PricingPage() {
  return (
    <>
      <Navbar />
      <main className="pt-24 pb-16">
        {/* Hero */}
        <section className="px-8 max-w-[1100px] mx-auto text-center mb-20 max-sm:px-6">
          <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
            Pricing
          </div>
          <h1 className="font-serif text-[clamp(2.2rem,5vw,3.5rem)] tracking-tight mb-5 font-normal">
            Transparent, tiered pricing
          </h1>
          <p className="text-text-muted max-w-[600px] mx-auto text-lg leading-relaxed">
            Every business is different. Pick the tier that matches your needs
            today, and scale up as you grow. No hidden fees.
          </p>
        </section>

        {/* Services */}
        {services.map((service) => (
          <section
            key={service.name}
            className="px-8 max-w-[1100px] mx-auto mb-20 max-sm:px-6"
          >
            {/* Service header */}
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">{service.icon}</span>
              <h2 className="font-serif text-[clamp(1.5rem,3vw,2rem)] tracking-tight font-normal">
                {service.name}
              </h2>
            </div>
            <p className="text-text-muted mb-8 max-w-[600px]">
              {service.description}
            </p>

            {/* Tier cards */}
            <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5 max-sm:grid-cols-1">
              {service.tiers.map((t) => {
                const style = TIER_STYLES[t.tier] || TIER_STYLES.Basic;
                return (
                  <div
                    key={t.tier}
                    className={`bg-surface border rounded-2xl p-8 flex flex-col ${style.border}`}
                  >
                    <span
                      className={`text-[11px] uppercase tracking-[0.12em] font-semibold px-2.5 py-1 rounded-full self-start mb-4 ${style.badge}`}
                    >
                      {t.tier}
                    </span>

                    <div className="mb-1">
                      <span className="font-serif text-[clamp(1.3rem,2.5vw,1.75rem)] tracking-tight">
                        {t.setup}
                      </span>
                      <span className="text-sm text-text-muted ml-1.5">
                        setup
                      </span>
                    </div>
                    <p className="text-sm text-text-muted mb-6">
                      then {t.monthly}
                    </p>

                    <ul className="list-none space-y-2 mb-6 flex-1">
                      {t.features.map((f) => (
                        <li
                          key={f}
                          className="text-sm text-text-muted pl-5 relative before:content-['→'] before:absolute before:left-0 before:text-accent before:text-xs"
                        >
                          {f}
                        </li>
                      ))}
                    </ul>

                    <p className="text-xs text-text-dim mb-5 border-t border-border pt-4">
                      Ideal for: {t.ideal}
                    </p>

                    <a
                      href="/get-quote"
                      className={`block text-center py-3 rounded-full font-semibold text-sm no-underline transition-all ${
                        t.tier === "Standard"
                          ? "bg-accent text-bg border border-accent"
                          : "border border-border-light text-text hover:border-text-muted"
                      }`}
                    >
                      Get a Quote
                    </a>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {/* CTA */}
        <section className="px-8 max-w-[1100px] mx-auto text-center mt-8 max-sm:px-6">
          <div className="bg-surface border border-border rounded-2xl p-12 max-sm:p-8">
            <h2 className="font-serif text-[clamp(1.5rem,3vw,2.2rem)] tracking-tight mb-3 font-normal">
              Not sure which tier you need?
            </h2>
            <p className="text-text-muted mb-8 max-w-[500px] mx-auto">
              Tell us about your business and we&apos;ll recommend the right
              solution and give you an exact quote. No obligation.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <a
                href="/get-quote"
                className="bg-accent text-bg px-8 py-3 rounded-full font-semibold text-sm no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
              >
                Get a Free Quote &rarr;
              </a>
              <a
                href="https://wa.me/27731231909?text=Hi%20KasiTek%2C%20I%27d%20like%20to%20discuss%20pricing"
                className="border border-border-light text-text px-8 py-3 rounded-full font-semibold text-sm no-underline transition-all hover:border-text-muted"
              >
                Chat on WhatsApp
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
