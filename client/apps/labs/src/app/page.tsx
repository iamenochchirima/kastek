import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Braces,
  Layers3,
  MessageSquare,
  Radio,
  Workflow,
} from "lucide-react";
import Image from "next/image";

const appUrl = process.env.NEXT_PUBLIC_KASITEK_APP_URL ?? "http://localhost:3000";
const demoUrl = process.env.NEXT_PUBLIC_KASITEK_DEMO_URL ?? `${appUrl}/demo`;
const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";

const disciplines = [
  {
    title: "Products",
    icon: Layers3,
    text:
      "Kasitek brings customer work, growth activity and automation into one connected workspace.",
    tags: ["Inbox & contacts", "Campaigns", "Content & calendar", "Agents"],
  },
  {
    title: "Services",
    icon: Workflow,
    text:
      "We configure, extend and connect the platform around the work your team needs to get done.",
    tags: [
      "Implementation",
      "Integrations",
      "Websites & bookings",
      "Managed support",
    ],
  },
  {
    title: "Partnership",
    icon: Braces,
    text:
      "Agencies can deliver Kasitek under their own brand, backed by the platform and our technical team.",
    tags: [
      "White-label workspaces",
      "Client accounts",
      "Agency operations",
      "Technical delivery",
    ],
  },
];

const operatingAreas = [
  {
    title: "Customer",
    subtitle: "Inbox, contacts and bookings",
    text:
      "Keep conversations, calls, customer records and appointments close to the people doing the work.",
    icon: MessageSquare,
  },
  {
    title: "Growth",
    subtitle: "Campaigns, templates and content",
    text:
      "Plan outreach, manage reusable content and keep your calendar moving from the same workspace.",
    icon: Radio,
  },
  {
    title: "Automation",
    subtitle: "Agents and workflows",
    text:
      "Use controlled agents for repeatable customer work, with your team ready to step in when it matters.",
    icon: Bot,
  },
];

const processSteps = [
  ["Find the friction", "We map the work, the handoffs and the real constraint."],
  ["Build the useful thing", "A focused first release, connected to the systems you already use."],
  ["Stay for the outcome", "We measure, improve and operate what matters after launch."],
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
        <div className="hero-copy">
          <h1>
            Useful tech.
            <span>Beautifully put to work.</span>
          </h1>

          <div className="hero-intro">
            <p>
              We design software, AI agents and connected customer systems for
              businesses that have outgrown patchwork tools.
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

        <div className="systems-stage" aria-label="A connected operating system illustration">
          <div className="signal-orbit orbit-one" />
          <div className="signal-orbit orbit-two" />
          <div className="signal-line signal-line-one" />
          <div className="signal-line signal-line-two" />

          <div className="system-core">
            <span className="core-k">K</span>
            <span className="core-pulse" />
          </div>

          <div className="system-node node-listen">
            <strong>Listen</strong>
            <span>Inbox</span>
          </div>
          <div className="system-node node-decide">
            <strong>Decide</strong>
            <span>Agents</span>
          </div>
          <div className="system-node node-act">
            <strong>Act</strong>
            <span>Campaigns</span>
          </div>
          <div className="system-node node-learn">
            <strong>Learn</strong>
            <span>Analytics</span>
          </div>

        </div>
      </section>

      <section className="ticker" aria-label="Kasitek Labs capabilities">
        <div className="ticker-track">
          <span>Product design</span>
          <i>✦</i>
          <span>AI systems</span>
          <i>✦</i>
          <span>WhatsApp &amp; Meta</span>
          <i>✦</i>
          <span>Custom software</span>
          <i>✦</i>
          <span>White-label infrastructure</span>
          <i>✦</i>
          <span>Product design</span>
          <i>✦</i>
          <span>AI systems</span>
          <i>✦</i>
          <span>WhatsApp &amp; Meta</span>
        </div>
      </section>

      <section className="statement section-pad">
        <div className="statement-copy">
          <h2>
            Technology should make the work feel
            <em> simpler.</em>
          </h2>
          <p className="statement-note">
            We start with the bottleneck—not the buzzword. Then we design the
            smallest system that can move the business forward.
          </p>
        </div>
      </section>

      <section className="disciplines section-pad" id="work">
        <div className="section-heading">
          <h2>One platform.<br />Three ways to work with us.</h2>
          <p>
            Use Kasitek directly, bring us in to build, or deliver it under your
            own brand.
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
          <h2>One workspace for customer work.</h2>
          <p>
            Kasitek keeps the customer context connected—from the first message
            to the follow-up, campaign, appointment and report.
          </p>
          <a className="button button-dark" href={appUrl}>
            Open Kasitek
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>

        <div className="operating-list">
          {operatingAreas.map((area) => (
            <article key={area.title} className="operating-row">
              <area.icon aria-hidden="true" />
              <div>
                <p>{area.subtitle}</p>
                <h3>{area.title}</h3>
              </div>
              <p className="operating-copy">{area.text}</p>
              <ArrowUpRight className="operating-arrow" aria-hidden="true" />
            </article>
          ))}
        </div>
      </section>

      <section className="approach section-pad" id="approach">
        <div className="approach-heading">
          <h2>Small team.<br />Clear decisions.<br />Real delivery.</h2>
        </div>

        <div className="process-list">
          {processSteps.map(([title, text]) => (
            <article key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="partner-section section-pad" id="partners">
        <div className="partner-mark" aria-hidden="true">
          <span>K</span>
          <span>+</span>
        </div>
        <div className="partner-copy">
          <h2>Your brand in front.<br />Serious infrastructure behind it.</h2>
          <p>
            Give clients a polished software experience without building the
            platform, integrations and operating layer from scratch.
          </p>
          <a className="button button-acid" href={`mailto:${contactEmail}?subject=Kasitek partner enquiry`}>
            Talk partnerships
            <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </section>

      <section className="final-cta section-pad">
        <div>
          <p className="eyebrow dark-eyebrow">Have a messy process?</p>
          <h2>Good.<br />That&apos;s where we start.</h2>
        </div>
        <a className="round-cta" href={`mailto:${contactEmail}?subject=Project enquiry`}>
          <span>Tell us<br />about it</span>
          <ArrowUpRight aria-hidden="true" />
        </a>
      </section>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="#top" aria-label="Back to top">
          <Image className="brand-mark" src="/logo.png" alt="" width={40} height={40} />
          <span className="wordmark-name">
            Kasitek
            <small>Labs</small>
          </span>
        </a>
        <div className="footer-links">
          <a href={appUrl}>Kasitek app</a>
          <a href={`mailto:${contactEmail}`}>{contactEmail}</a>
          <a href="#top">Back to top ↑</a>
        </div>
        <div className="footer-bottom">
          <p>Product company &amp; technology studio.</p>
          <p>Johannesburg, South Africa</p>
          <p>© {new Date().getFullYear()} Kasitek Labs</p>
        </div>
      </footer>
    </main>
  );
}
