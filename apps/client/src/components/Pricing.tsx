const plans = [
  {
    tier: "Starter",
    name: "WhatsApp Chatbot",
    setup: "R2,500",
    monthly: "R300/mo",
    features: [
      "AI-powered WhatsApp chatbot",
      "FAQ & booking automation",
      "Business hours auto-responder",
      "Lead capture & notifications",
      "Email support",
    ],
    featured: false,
  },
  {
    tier: "Most Popular",
    name: "Growth",
    setup: "R5,000",
    monthly: "R600/mo",
    features: [
      "Everything in Starter",
      "Website chatbot included",
      "CRM & calendar integration",
      "Automated follow-ups",
      "Priority support",
    ],
    featured: true,
  },
  {
    tier: "Premium",
    name: "Full AI Suite",
    setup: "R12,000",
    monthly: "R1,200/mo",
    features: [
      "Everything in Growth",
      "AI voice agent",
      "Advanced automations",
      "Custom integrations",
      "Dedicated account manager",
    ],
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
        Simple, affordable pricing
      </h2>
      <p className="text-text-muted max-w-[550px] mb-14 text-lg leading-relaxed">
        Flexible plans that grow with your business. Setup fees quoted
        separately based on your needs.
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
            <div className="mb-6">
              <span className="font-serif text-[clamp(1.5rem,3vw,2rem)] tracking-tight">{plan.setup}</span>
              <span className="text-sm text-text-muted ml-1">once-off</span>
              <div className="text-sm text-text-muted mt-1">then {plan.monthly} after setup</div>
            </div>
            <ul className="list-none mb-8 space-y-1">
              {plan.features.map((feature) => (
                <li
                  key={feature}
                  className="text-sm text-text-muted py-1.5 pl-5 relative before:content-['→'] before:absolute before:left-0 before:text-accent before:text-xs"
                >
                  {feature}
                </li>
              ))}
            </ul>
            <div className="flex gap-3">
              <a
                href="/get-quote"
                className={`flex-1 block text-center py-3 rounded-full font-semibold text-sm no-underline transition-all ${
                  plan.featured
                    ? "bg-accent text-bg border border-accent"
                    : "border border-border-light text-text"
                }`}
              >
                Get a Quote
              </a>
              <a
                href="https://wa.me/27731231909?text=Hi%20KasiAI%2C%20I'm%20interested%20in%20the%20${encodeURIComponent(plan.name)}%20plan"
                className="flex-1 block text-center py-3 rounded-full font-semibold text-sm no-underline border border-border-light text-text-muted transition-all hover:border-text-muted"
              >
                Contact Us
              </a>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
