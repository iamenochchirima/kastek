import type { Metadata } from "next";
import Link from "next/link";
import { Bot, Cable, PanelsTopLeft, Workflow } from "lucide-react";
import { InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { appUrl } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Pricing | Kasitek Labs",
  description:
    "Monthly Kasitek plans and scoped pricing for agents, integrations and custom software.",
};

const productTiers = [
  {
    name: "Basic",
    monthly: "$25 / month",
    description: "For one business starting with the core Kasitek workspace.",
    features: [
      "One workspace and brand",
      "Core communication, content and automation",
      "Guided setup",
    ],
  },
  {
    name: "Growth",
    monthly: "$45 / month",
    featured: true,
    description: "For a team running more channels and automated work.",
    features: [
      "More channels and usage",
      "Advanced workflow configuration",
      "Priority delivery support",
    ],
  },
  {
    name: "Scale",
    monthly: "$75 / month",
    description: "For larger teams and more involved integrations.",
    features: [
      "Expanded team access",
      "Advanced routing and integrations",
      "Tailored rollout",
    ],
  },
];

const customWork = [
  {
    title: "AI agents",
    description: "Messaging, voice and operational agents.",
    icon: Bot,
  },
  {
    title: "Workflows and integrations",
    description: "AI workflows connected across your existing tools and data.",
    icon: Cable,
  },
  {
    title: "Applications and portals",
    description: "Software for customers, staff and operations.",
    icon: PanelsTopLeft,
  },
  {
    title: "Forward-deployed delivery",
    description: "Engineering through design, launch and iteration. Coming soon.",
    icon: Workflow,
    comingSoon: true,
  },
];

export default function PricingPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Pricing"
        title={<>Pricing.</>}
        introduction="Monthly plans for Kasitek. Custom delivery is scoped separately."
        compact
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Kasitek.</h2>
          <p>Monthly platform plans.</p>
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
                href={appUrl}
                target="_blank"
                rel="noreferrer"
              >
                Get started
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-muted">
        <div className="inner-section-heading">
          <h2>Custom work.</h2>
          <div className="inner-section-heading-action">
            <p>Quoted against the system, integrations and delivery required.</p>
            <Link
              className="button button-dark"
              href="/get-quote?service=custom-delivery"
            >
              Request a quote
            </Link>
          </div>
        </div>
        <div className="feature-list">
          {customWork.map((item) => (
            <article className="feature-row" key={item.title}>
              <h3>
                <item.icon aria-hidden="true" />
                {item.title}
                {item.comingSoon ? <span className="coming-soon-badge">Coming soon</span> : null}
              </h3>
              <p>{item.description}</p>
            </article>
          ))}
        </div>
      </section>

    </LabsInnerShell>
  );
}
