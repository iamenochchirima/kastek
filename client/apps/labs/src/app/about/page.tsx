import type { Metadata } from "next";
import { Braces, Layers3, Workflow } from "lucide-react";
import { ContactPanel, InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";

export const metadata: Metadata = {
  title: "About | Kasitek Labs",
  description:
    "Kasitek Labs builds software products and operational systems for businesses and partners.",
};

const work = [
  {
    title: "Products",
    description:
      "Software we build and operate. Kasitek is the first product: a workspace for communication, content, campaigns, bookings and automation.",
    icon: Layers3,
  },
  {
    title: "Client delivery",
    description:
      "We build AI agents, integrations and web applications for specific business operations.",
    icon: Workflow,
  },
  {
    title: "Partner infrastructure",
    description:
      "We provide branded workspaces and technical delivery for agencies and service partners.",
    icon: Braces,
  },
];

export default function AboutPage() {
  return (
    <LabsInnerShell>
      <div className="about-page">
        <InnerHero
          context="About"
          title={<>A product and delivery company.</>}
          introduction="Kasitek Labs creates AI-powered products, applications and connected systems for businesses, teams and partners."
        />

        <section className="about-statement">
          <div>
            <p>Our point of view</p>
            <h2>The work comes first.</h2>
          </div>
          <div>
            <p>
              Businesses run on more than a product interface. The work depends on
              the systems, people and decisions around it.
            </p>
            <p>
              Kasitek Labs builds and operates its own products, then brings that
              same practical approach to client delivery and partner infrastructure.
            </p>
          </div>
        </section>

        <section className="inner-section about-work">
          <div className="inner-section-heading">
            <h2>Three ways to work with us.</h2>
            <p>
              One company that builds products, delivers for clients and supports
              partners under their own brand.
            </p>
          </div>
          <div className="editorial-grid editorial-grid-three">
            {work.map((item) => (
              <article className="editorial-card" key={item.title}>
                <item.icon aria-hidden="true" />
                <h2>{item.title}</h2>
                <p>{item.description}</p>
              </article>
            ))}
          </div>
        </section>

        <ContactPanel
          title="Have something that needs to be built?"
          subject="Company enquiry"
        />
      </div>
    </LabsInnerShell>
  );
}
