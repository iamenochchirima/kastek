const plans = [
  {
    tier: "Starter",
    name: "Smart Assistant",
    price: "From R8,000 setup + R3,000/month",
    features: [
      "WhatsApp chatbot with FAQ & booking",
      "Up to 500 conversations/month",
      "Business hours auto-responder",
      "Basic analytics dashboard",
      "Email support",
    ],
    cta: "Get Started",
    featured: false,
  },
  {
    tier: "Most Popular",
    name: "Growth Engine",
    price: "From R20,000 setup + R6,000/month",
    features: [
      "WhatsApp + website chatbot",
      "CRM & calendar integration",
      "Lead qualification & routing",
      "Automated follow-ups & reminders",
      "Quote/invoice automation",
      "Priority support",
    ],
    cta: "Get Started",
    featured: true,
  },
  {
    tier: "Enterprise",
    name: "Full AI Suite",
    price: "From R50,000 setup + R10,000/month",
    features: [
      "Everything in Growth",
      "AI voice agent",
      "Custom AI agents for operations",
      "Staff knowledge base",
      "Advanced reporting & insights",
      "Dedicated account manager",
    ],
    cta: "Let's Talk",
    featured: false,
  },
];

export default function Pricing() {
  return (
    <section
      id="pricing"
      className="py-24 px-8 max-w-[1100px] mx-auto border-t border-border max-sm:py-16 max-sm:px-6"
    >
      <div className="text-xs uppercase tracking-[0.15em] text-accent mb-4 font-semibold">
        Pricing
      </div>
      <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] tracking-tight mb-4 font-normal">
        Simple, transparent pricing
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        No hidden fees. No surprises. Just clear value for your investment.
      </p>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-5 max-sm:grid-cols-1">
        {plans.map((plan) => (
          <div
            key={plan.name}
            className={`bg-surface border rounded-2xl p-9 transition-all ${
              plan.featured
                ? "border-accent bg-gradient-to-b from-accent/[0.03] to-surface"
                : "border-border"
            }`}
          >
            <div
              className={`text-xs uppercase tracking-[0.12em] font-semibold mb-2 ${
                plan.featured ? "text-accent" : "text-text-dim"
              }`}
            >
              {plan.tier}
            </div>
            <h3 className="font-serif text-2xl mb-1 font-normal">
              {plan.name}
            </h3>
            <div className="text-sm text-text-muted mb-6">{plan.price}</div>
            <ul className="list-none mb-6 space-y-1">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="text-sm text-text-muted py-1.5 pl-5 relative before:content-['→'] before:absolute before:left-0 before:text-accent before:text-xs"
                >
                  {feature}
                </li>
              ))}
            </ul>
            <a
              href="#contact"
              className={`block text-center py-3 rounded-full font-semibold text-sm no-underline transition-all ${
                plan.featured
                  ? "bg-accent text-bg border border-accent"
                  : "border border-border-light text-text"
              }`}
            >
              {plan.cta}
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}
