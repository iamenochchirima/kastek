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
      "Kasitek is our AI-enabled workspace for customer engagement, growth activity and automation.",
    tags: ["Inbox & contacts", "Campaigns", "Content & calendar", "Agents"],
  },
  {
    title: "Services",
    icon: Workflow,
    text:
      "We design, implement and support systems that fit your team and the way it works.",
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
      "Deliver your own client experience on infrastructure built and operated by Kasitek Labs.",
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

      <section className="statement section-pad">
        <div className="statement-copy">
          <h2>
            AI should earn its place in the
            <em> business.</em>
          </h2>
          <p className="statement-note">
            We start with the work, the context and the constraint. Then we build
            the product, service or system that can make a measurable difference.
          </p>
        </div>
      </section>

      <section className="disciplines section-pad" id="work">
        <div className="section-heading">
          <h2>Three ways to work<br />with Kasitek Labs.</h2>
          <p>
            Use Kasitek directly, bring us in to build, or deliver a client
            experience under your own brand.
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
          <h2>Kasitek: AI-powered customer operations.</h2>
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
          <h2>Built around the work.<br />Not the trend.</h2>
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
          <p>AI products &amp; technology services.</p>
          <p>Durban, South Africa</p>
          <p>© {new Date().getFullYear()} Kasitek Labs</p>
        </div>
      </footer>
    </main>
  );
}
