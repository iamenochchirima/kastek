import type { Metadata } from "next";
import Link from "next/link";
import { Bot, Cable, PanelsTopLeft, Workflow } from "lucide-react";
import { InnerHero } from "@/components/labs-inner-page";
import { LabsInnerShell } from "@/components/labs-site-chrome";
import { productUrls } from "@/lib/site-config";

export const metadata: Metadata = {
  title: "Plans | Kasitek Labs",
  description:
    "Growth and Agents plans live on their product sites. Custom delivery is scoped separately.",
};

const products = [
  {
    name: "Growth",
    description: "Customer conversations, campaigns, content and bookings.",
    href: `${productUrls.growth}/pricing`,
    icon: PanelsTopLeft,
  },
  {
    name: "Agents",
    description: "Customer-service agents, knowledge and a shared inbox.",
    href: `${productUrls.agents}/pricing`,
    icon: Bot,
  },
  {
    name: "Agency",
    description: "Client workspaces and partner delivery. Agency is in early access.",
    href: "/contact",
    icon: Workflow,
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

export default function PlansPage() {
  return (
    <LabsInnerShell>
      <InnerHero
        context="Plans"
        title={<>Product plans.</>}
        introduction="Growth and Agents have their own plans. Choose a product to see current pricing."
        compact
      />

      <section className="inner-section">
        <div className="inner-section-heading">
          <h2>Products.</h2>
          <p>Plan details, limits and checkout live on each product site.</p>
        </div>
        <div className="editorial-grid editorial-grid-three">
          {products.map((product) => (
            <article className="editorial-card" key={product.name}>
              <h2>{product.name}</h2>
              <p>{product.description}</p>
              <ul>
                <li>— Current plans and prices</li>
                <li>— Limits and included features</li>
                <li>— Monthly billing</li>
              </ul>
              {product.href.startsWith("http") ? (
                <a
                  className="button button-dark"
                  href={product.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  View {product.name} plans
                </a>
              ) : (
                <Link className="button button-dark" href={product.href}>
                  Talk to us
                </Link>
              )}
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
