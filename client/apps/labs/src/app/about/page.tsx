import type { Metadata } from "next";
import { Bot, Braces, Layers3, Workflow } from "lucide-react";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";

export const metadata: Metadata = {
  title: "About | Kasitek Labs",
  description:
    "Kasitek Labs builds AI products, operational systems and white-label infrastructure.",
};

const capabilities = [
  {
    title: "AI products",
    description:
      "Kasitek is our workspace for communication, content, campaigns, bookings and automated workflows.",
    icon: Layers3,
  },
  {
    title: "Delivery",
    description:
      "We design and build AI agents, connected workflows, applications and portals for client operations.",
    icon: Workflow,
  },
  {
    title: "Applied AI",
    description:
      "AI is assigned a defined role, connected to the required information and kept within clear operating controls.",
    icon: Bot,
  },
  {
    title: "White-label infrastructure",
    description:
      "Partners can run branded workspaces for their teams and clients on infrastructure operated by Kasitek Labs.",
    icon: Braces,
  },
];

export default function AboutPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="About Kasitek Labs"
        title={<>The business behind the platform.</>}
        introduction="Kasitek Labs builds and operates software for communication, growth activity and everyday business operations."
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Products, delivery and infrastructure.</h2>
          <p>
            Clients can use Kasitek directly, bring our team into a specific
            implementation, or deliver a branded platform to their own clients.
          </p>
        </div>
        <div className="editorial-grid">
          {capabilities.map((capability) => (
            <article className="editorial-card" key={capability.title}>
              <capability.icon aria-hidden="true" />
              <h3>{capability.title}</h3>
              <p>{capability.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="inner-section inner-section-muted">
        <div className="inner-section-heading">
          <h2>Where the work begins.</h2>
          <p>
            We start with the operation: what needs to happen, who is involved
            and which systems already carry the work.
          </p>
        </div>
        <div className="feature-list">
          <article className="feature-row">
            <h3>Business teams</h3>
            <p>
              Communication, bookings, campaigns, content, service workflows
              and reporting brought into a practical working system.
            </p>
          </article>
          <article className="feature-row">
            <h3>Agencies and consultants</h3>
            <p>
              Branded client workspaces, delivery infrastructure and technical
              implementation behind the partner&apos;s own service.
            </p>
          </article>
          <article className="feature-row">
            <h3>Software teams</h3>
            <p>
              AI features, integrations and operational tooling designed to fit
              an existing product or internal platform.
            </p>
          </article>
        </div>
      </section>

      <ContactPanel title="Have an operation that needs a proper system?" />
    </LabsInnerShell>
  );
}
