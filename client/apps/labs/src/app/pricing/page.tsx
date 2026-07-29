import type { Metadata } from "next";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";
import { contactEmail } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Pricing | Kasitek Labs",
  description:
    "Kasitek workspace plans and starting ranges for custom AI and software delivery.",
};

const productTiers = [
  {
    name: "Basic",
    monthly: "R450 / month",
    description:
      "For one business getting its core communication and operating workspace in place.",
    features: [
      "One Kasitek workspace",
      "Core communication, content and automation tools",
      "Single business and brand",
      "Guided onboarding",
      "Standard usage limits and updates",
    ],
  },
  {
    name: "Growth",
    monthly: "R799 / month",
    featured: true,
    description:
      "For teams running more channels, campaigns and automated work through Kasitek.",
    features: [
      "Higher workspace usage",
      "Multiple connected channels",
      "Advanced workflow configuration",
      "Expanded campaigns and content activity",
      "Priority delivery support",
    ],
  },
  {
    name: "Scale",
    monthly: "R1,299 / month",
    description:
      "For larger teams, deeper integrations and a more involved operational rollout.",
    features: [
      "Higher limits and expanded access",
      "Multi-team operating support",
      "Advanced routing and integrations",
      "Complex workflow configuration",
      "Closer optimisation and rollout support",
    ],
  },
];

const services = [
  {
    title: "AI agents",
    price: "From R4,500",
    description:
      "Defined agent roles for messaging, service, booking, qualification or internal work.",
  },
  {
    title: "Voice agents",
    price: "From R8,500",
    description:
      "Inbound call handling, appointment booking, screening, FAQs and routing.",
  },
  {
    title: "Workflow integration",
    price: "From R3,500",
    description:
      "AI-assisted workflows connected to existing systems, information and approvals.",
  },
  {
    title: "System integrations",
    price: "From R5,000",
    description:
      "Connections to CRMs, booking tools, calendars, data sources and internal platforms.",
  },
  {
    title: "Web applications and portals",
    price: "From R6,500",
    description:
      "Customer applications, internal tools, dashboards and operational interfaces.",
  },
  {
    title: "Managed delivery",
    price: "Scoped quote",
    description:
      "Ongoing operation, review and extension after the initial system goes live.",
  },
];

export default function PricingPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Pricing"
        title={<>Products by plan. Delivery by scope.</>}
        introduction="Kasitek is priced monthly. Custom agents, integrations and applications are scoped against the work required."
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Kasitek workspace plans.</h2>
          <p>
            Indicative monthly plans. Final access and usage limits are
            confirmed during onboarding.
          </p>
        </div>
        <div className="editorial-grid editorial-grid-three">
          {productTiers.map((tier) => (
            <article
              className={`editorial-card price-card${tier.featured ? " is-featured" : ""}`}
              key={tier.name}
            >
              <h2>{tier.name}</h2>
              <div className="price">{tier.monthly}</div>
              <p>{tier.description}</p>
              <ul>
                {tier.features.map((feature) => (
                  <li key={feature}>— {feature}</li>
                ))}
              </ul>
              <a
                className="button button-dark"
                href={`mailto:${contactEmail}?subject=${encodeURIComponent(`${tier.name} plan enquiry`)}`}
              >
                Discuss this plan
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-muted">
        <div className="inner-section-heading">
          <h2>Custom delivery.</h2>
          <p>
            Starting ranges help set an initial budget. A final quote follows a
            short scope and systems review.
          </p>
        </div>
        <div className="editorial-grid editorial-grid-three">
          {services.map((service) => (
            <article className="editorial-card" key={service.title}>
              <p>{service.price}</p>
              <h3>{service.title}</h3>
              <p>{service.description}</p>
            </article>
          ))}
        </div>
      </section>

      <ContactPanel
        title="Move from a price range to a proper scope."
        subject="Pricing and scope enquiry"
      />
    </LabsInnerShell>
  );
}
