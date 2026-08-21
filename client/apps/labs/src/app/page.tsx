import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Braces,
  Layers3,
  Workflow,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { ProductWorkspacePreview } from "@/components/product-workspace-preview";
import { ServiceDeliveryMontage } from "@/components/service-delivery-montage";
import { PartnershipWorkspacePreview } from "@/components/partnership-workspace-preview";
import { LabsFooter, LabsHeader } from "@/components/labs-site-chrome";
import { appUrl } from "@/lib/site-config";

const disciplines = [
  {
    title: "Products",
    icon: Layers3,
    text:
      "Kasitek is our AI-enabled workspace for customer engagement, growth activity and automation.",
    tags: ["Inbox & contacts", "Campaigns", "Content & calendar", "Agents"],
  },
  {
    title: "Services",
    icon: Workflow,
    text:
      "We design and deliver AI agents, connected workflows and web applications for client operations.",
    tags: [
      "AI agents",
      "Workflow integration",
      "Web apps & portals",
      "Forward-deployed delivery · Coming soon",
    ],
  },
  {
    title: "Partnership",
    icon: Braces,
    text:
      "Deliver your own client experience on infrastructure built and operated by Kasitek Labs.",
    tags: [
      "White-label workspaces",
      "Client accounts",
      "Agency operations",
      "Technical delivery",
    ],
  },
];

export default function LabsLandingPage() {
  return (
    <main className="labs-page">
      <LabsHeader home />
      <script
        async
        src="http://localhost:4000/api/widget/v1/loader.js"
        data-kasitek-deployment="wdg_vr6p4v6p62qsospw8ocs0f10"
      />

      <section className="hero" id="top">
        <div className="hero-image" aria-hidden="true">
          <Image
            src="/hero-mountain-study.jpg"
            alt=""
            fill
            sizes="100vw"
            priority
          />
        </div>

        <div className="hero-copy">
          <h1>
            Useful AI.
            <span>Beautifully put to work.</span>
          </h1>

          <div className="hero-intro">
            <p>
              Kasitek Labs builds AI products and technology services for
              customer engagement, business growth and everyday operations.
            </p>
            <div className="hero-actions">
              <Link className="button button-light" href="/demo">
                See Kasitek
                <ArrowRight aria-hidden="true" />
              </Link>
              <a className="text-link" href="#work">
                Explore the studio
                <ArrowDown aria-hidden="true" />
              </a>
            </div>
          </div>
        </div>

      </section>

      <section className="ticker" aria-label="Kasitek Labs capabilities">
        <div className="ticker-track">
          <span>AI products</span>
          <i>✦</i>
          <span>Customer operations</span>
          <i>✦</i>
          <span>Growth systems</span>
          <i>✦</i>
          <span>Custom software</span>
          <i>✦</i>
          <span>White-label infrastructure</span>
          <i>✦</i>
          <span>AI products</span>
          <i>✦</i>
          <span>Customer operations</span>
          <i>✦</i>
          <span>Growth systems</span>
        </div>
      </section>

      <section className="disciplines section-pad" id="work">
        <div className="section-heading">
          <h2>
            AI should earn its place in the <em>business.</em>
          </h2>
          <p>
            Use Kasitek directly, bring us in to build, or deliver the platform
            under your own brand.
          </p>
        </div>

        <div className="discipline-grid">
          {disciplines.map((discipline) => (
            <article className="discipline-card" key={discipline.title}>
              <div className="discipline-top">
                <discipline.icon aria-hidden="true" />
              </div>
              <h3>{discipline.title}</h3>
              <p>{discipline.text}</p>
              <ul>
                {discipline.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="operating-system section-pad" id="kasitek">
        <div className="operating-intro">
          <h2>
            The AI workspace for business operations.
          </h2>
          <div className="operating-copy">
            <p>
              Manage communication, content, campaigns, bookings and automated
              workflows from one place.
            </p>
          </div>
          <a
            className="button button-dark"
            href={appUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open Kasitek
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
        <ProductWorkspacePreview />
      </section>

      <section className="approach section-pad" id="approach">
        <div className="approach-heading">
          <h2>Built around your work.</h2>
          <div className="approach-details">
            <p>We design, build and deliver systems that fit the way your business actually operates.</p>
            <Link className="approach-cta" href="/get-quote?service=delivery">
              Start a project
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </div>
        </div>
        <ServiceDeliveryMontage />
      </section>

      {/* Forward-deployed delivery section hidden for now. */}

      <section className="partner-section section-pad" id="partners">
        <div className="partner-copy">
          <h2>Deliver more<br />under your own brand.</h2>
          <p>
            Give clients AI-powered workspaces, services and automation without
            building and maintaining the platform yourself.
          </p>
          <Link className="button button-acid" href="/contact?type=partnership">
            Talk partnerships
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
        <PartnershipWorkspacePreview />
      </section>

      <section className="final-cta section-pad">
        <div>
          <p className="contact-prompt">Have a messy process?</p>
          <h2>Good.<br />That&apos;s where we start.</h2>
        </div>
        <Link className="round-cta" href="/contact">
          <span>Tell us<br />about it</span>
          <ArrowUpRight aria-hidden="true" />
        </Link>
      </section>

      <LabsFooter />
    </main>
  );
}
