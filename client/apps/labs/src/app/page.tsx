import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Braces,
  Layers3,
  Workflow,
} from "lucide-react";
import Image from "next/image";
import { ProductWorkspacePreview } from "@/components/product-workspace-preview";
import { ServiceDeliveryMontage } from "@/components/service-delivery-montage";
import { PartnershipWorkspacePreview } from "@/components/partnership-workspace-preview";

const appUrl = process.env.NEXT_PUBLIC_KASITEK_APP_URL ?? "http://localhost:3000";
const demoUrl = process.env.NEXT_PUBLIC_KASITEK_DEMO_URL ?? `${appUrl}/demo`;
const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";

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
      "Forward-deployed delivery",
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
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Kasitek Labs home">
          <Image
            className="brand-mark"
            src="/logo.png"
            alt=""
            width={40}
            height={40}
            priority
          />
          <span className="wordmark-name">
            Kasitek
            <small>Labs</small>
          </span>
        </a>

        <nav className="desktop-nav" aria-label="Main navigation">
          <a href="#work">What we build</a>
          <a href="#approach">How we work</a>
          <a href="#partners">Partners</a>
        </nav>

        <a className="header-cta" href={`mailto:${contactEmail}?subject=Project enquiry`}>
          Start a project
          <ArrowUpRight aria-hidden="true" />
        </a>

        <details className="mobile-nav">
          <summary>Menu</summary>
          <div className="mobile-nav-panel">
            <a href="#work">What we build</a>
            <a href="#approach">How we work</a>
            <a href="#partners">Partners</a>
            <a href={`mailto:${contactEmail}?subject=Project enquiry`}>Start a project</a>
          </div>
        </details>
      </header>

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
              <a className="button button-light" href={demoUrl}>
                See Kasitek
                <ArrowRight aria-hidden="true" />
              </a>
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

      <section className="operating-system section-pad">
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
          <a className="button button-dark" href={appUrl}>
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
            <a className="approach-cta" href={`mailto:${contactEmail}?subject=Project enquiry`}>
              Start a project
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
        <ServiceDeliveryMontage />
      </section>

      {/* Forward-deployed delivery section hidden for now. */}

      <section className="partner-section section-pad" id="partners">
        <div className="partner-copy">
          <h2>Your brand in front.<br />The platform behind it.</h2>
          <p>
            Give clients a polished software experience without building the
            platform, integrations and operating layer yourself.
          </p>
          <a className="button button-acid" href={`mailto:${contactEmail}?subject=Kasitek partner enquiry`}>
            Talk partnerships
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
        <PartnershipWorkspacePreview />
      </section>

      <section className="final-cta section-pad">
        <div>
          <p className="contact-prompt">Have a messy process?</p>
          <h2>Good.<br />That&apos;s where we start.</h2>
        </div>
        <a className="round-cta" href={`mailto:${contactEmail}?subject=Project enquiry`}>
          <small>Start a conversation</small>
          <span>Tell us<br />about it</span>
          <ArrowUpRight aria-hidden="true" />
        </a>
      </section>

      <footer className="site-footer">
        <div className="footer-primary">
          <div className="footer-brand">
            <a className="wordmark footer-wordmark" href="#top" aria-label="Kasitek Labs home">
              <Image className="brand-mark" src="/logo.png" alt="" width={40} height={40} />
              <span className="wordmark-name">
                Kasitek
                <small>Labs</small>
              </span>
            </a>
            <p>
              AI products, delivery and infrastructure for business operations.
            </p>
            <a className="footer-contact" href={`mailto:${contactEmail}`}>
              {contactEmail}
              <ArrowUpRight aria-hidden="true" />
            </a>
          </div>

          <nav className="footer-nav" aria-label="Footer navigation">
            <div className="footer-column">
              <p>Work with us</p>
              <a href="#work">Products</a>
              <a href="#approach">Services</a>
              <a href="#partners">Partnership</a>
              <a href={`mailto:${contactEmail}?subject=Project enquiry`}>Start a project</a>
            </div>
            <div className="footer-column">
              <p>Kasitek</p>
              <a href={appUrl}>Open Kasitek</a>
              <a href={`${appUrl}/solutions`}>Solutions</a>
              <a href={`${appUrl}/pricing`}>Pricing</a>
            </div>
            <div className="footer-column">
              <p>Company</p>
              <a href={`${appUrl}/about`}>About</a>
              <a href={`${appUrl}/meta-business-platform`}>Meta Platform</a>
              <a href={`mailto:${contactEmail}`}>Contact</a>
            </div>
            <div className="footer-column">
              <p>Legal</p>
              <a href={`${appUrl}/privacy-policy`}>Privacy</a>
              <a href={`${appUrl}/terms`}>Terms of Service</a>
              <a href={`${appUrl}/data-deletion`}>Data Deletion</a>
            </div>
          </nav>
        </div>

        <div className="footer-bottom">
          <p>© {new Date().getFullYear()} Kasitek Labs</p>
          <p>South Africa</p>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
