import type { Metadata } from "next";
import {
  BriefcaseBusiness,
  Building2,
  Layers3,
  Store,
} from "lucide-react";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";

export const metadata: Metadata = {
  title: "Solutions | Kasitek Labs",
  description:
    "Kasitek products and delivery models for businesses, agencies, software teams and multi-location operations.",
};

const audiences = [
  {
    title: "Business teams",
    description:
      "A working system for enquiries, conversations, bookings, campaigns, content and recurring operational tasks.",
    examples: ["Retail", "Clinics", "Hospitality", "Professional services"],
    icon: BriefcaseBusiness,
  },
  {
    title: "Agencies and consultants",
    description:
      "White-label workspaces and technical delivery that can sit behind your own client service.",
    examples: ["Agencies", "Consultancies", "Studios", "Growth partners"],
    icon: Building2,
  },
  {
    title: "Software teams",
    description:
      "AI agents, workflow integrations and operating interfaces added to an existing product or internal system.",
    examples: ["SaaS products", "Internal tools", "Portals", "Data systems"],
    icon: Layers3,
  },
  {
    title: "Multi-location operations",
    description:
      "Shared standards with location-aware communication, routing, campaigns and reporting.",
    examples: ["Franchises", "Branches", "Networks", "Distributed teams"],
    icon: Store,
  },
];

const deliveryModels = [
  {
    title: "Use Kasitek",
    description:
      "Start with the Kasitek workspace for communication, content, campaigns, bookings and automation.",
  },
  {
    title: "Build around the operation",
    description:
      "Commission an agent, workflow, integration, application or portal designed for a specific business process.",
  },
  {
    title: "Deliver under your brand",
    description:
      "Run a branded workspace for staff and client accounts while Kasitek Labs operates the platform behind it.",
  },
];

export default function SolutionsPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Solutions"
        title={<>Different operations. Clear ways to deploy.</>}
        introduction="Choose a product, a custom implementation or a partner model based on the work that needs to run."
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Built for the operating context.</h2>
          <p>
            The same infrastructure can serve a direct business team, a
            software product, a multi-location operation or a partner&apos;s
            client base.
          </p>
        </div>
        <div className="editorial-grid">
          {audiences.map((audience) => (
            <article className="editorial-card" key={audience.title}>
              <audience.icon aria-hidden="true" />
              <h2>{audience.title}</h2>
              <p>{audience.description}</p>
              <footer>
                {audience.examples.map((example) => (
                  <span key={example}>{example}</span>
                ))}
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-dark">
        <div className="inner-section-heading">
          <h2>Three delivery models.</h2>
          <p>
            Start with the level of ownership, tailoring and delivery support
            the operation actually requires.
          </p>
        </div>
        <div className="editorial-grid editorial-grid-three">
          {deliveryModels.map((model) => (
            <article className="editorial-card" key={model.title}>
              <h3>{model.title}</h3>
              <p>{model.description}</p>
            </article>
          ))}
        </div>
      </section>

      <ContactPanel title="Tell us what needs to work." subject="Solutions enquiry" />
    </LabsInnerShell>
  );
}
