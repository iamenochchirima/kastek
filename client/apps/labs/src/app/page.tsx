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

const appUrl = process.env.NEXT_PUBLIC_KASITEK_APP_URL ?? "http://localhost:3000";
const demoUrl = process.env.NEXT_PUBLIC_KASITEK_DEMO_URL ?? `${appUrl}/demo`;
const contactEmail =
  process.env.NEXT_PUBLIC_KASITEK_CONTACT_EMAIL ?? "hello@kasitek.co.za";

const disciplines = [
  {
    number: "01",
    title: "Product",
    icon: Layers3,
    text: "One workspace for conversations, campaigns, content and agents.",
    tags: ["Kasitek", "KasiAgents", "KasiReach", "KasiSocial"],
  },
  {
    number: "02",
    title: "Systems",
    icon: Workflow,
    text: "Custom software and automation shaped around how your team works.",
    tags: ["Web platforms", "AI agents", "Integrations", "Operations"],
  },
  {
    number: "03",
    title: "Partnerships",
    icon: Braces,
    text: "White-label infrastructure and technical delivery for agencies.",
    tags: ["Partner portals", "Client workspaces", "Managed delivery"],
  },
];

const operatingAreas = [
  {
    index: "A",
    title: "Talk",
    subtitle: "Customer conversations",
    text: "Bring WhatsApp, Meta and human handoff into one working inbox.",
    icon: MessageSquare,
  },
  {
    index: "B",
    title: "Reach",
    subtitle: "Campaigns that land",
    text: "Plan, send and learn without stitching together five tools.",
    icon: Radio,
  },
  {
    index: "C",
    title: "Run",
    subtitle: "Agents and workflows",
    text: "Put repeatable work on reliable rails, with people in control.",
    icon: Bot,
  },
];

const processSteps = [
  ["01", "Find the friction", "We map the work, the handoffs and the real constraint."],
  ["02", "Build the useful thing", "A focused first release, connected to the systems you already use."],
  ["03", "Stay for the outcome", "We measure, improve and operate what matters after launch."],
];

export default function LabsLandingPage() {
  return (
    <main className="labs-page">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Kasitek Labs home">
          <span className="wordmark-symbol" aria-hidden="true">
            K<span>/</span>L
          </span>
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
          <p className="eyebrow">
            <span className="status-dot" />
            Johannesburg · Building worldwide
          </p>

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
          <div className="stage-meta stage-meta-top">
            <span>KL / SYSTEM 01</span>
            <span>LIVE</span>
          </div>

          <div className="signal-orbit orbit-one" />
          <div className="signal-orbit orbit-two" />
          <div className="signal-line signal-line-one" />
          <div className="signal-line signal-line-two" />

          <div className="system-core">
            <span className="core-k">K</span>
            <span className="core-pulse" />
          </div>

          <div className="system-node node-listen">
            <small>01</small>
            <strong>Listen</strong>
            <span>Inbox</span>
          </div>
          <div className="system-node node-decide">
            <small>02</small>
            <strong>Decide</strong>
            <span>Agents</span>
          </div>
          <div className="system-node node-act">
            <small>03</small>
            <strong>Act</strong>
            <span>Campaigns</span>
          </div>
          <div className="system-node node-learn">
            <small>04</small>
            <strong>Learn</strong>
            <span>Analytics</span>
          </div>

          <div className="stage-meta stage-meta-bottom">
            <span>Human in control</span>
            <span>26.2041° S / 28.0473° E</span>
          </div>
        </div>

        <div className="hero-index" aria-hidden="true">
          <span>PRODUCT</span>
          <span>SYSTEMS</span>
          <span>PARTNERS</span>
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
        <div className="section-label">
          <span>00</span>
          <p>The point</p>
        </div>
        <div className="statement-copy">
          <p className="statement-kicker">Not another AI wrapper.</p>
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
          <div className="section-label light-label">
            <span>01</span>
            <p>What we build</p>
          </div>
          <h2>One studio.<br />Three ways in.</h2>
          <p>Use the product. Build something specific. Or partner with us.</p>
        </div>

        <div className="discipline-grid">
          {disciplines.map((discipline) => (
            <article className="discipline-card" key={discipline.number}>
              <div className="discipline-top">
                <span>{discipline.number}</span>
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
          <div className="section-label">
            <span>02</span>
            <p>The product</p>
          </div>
          <h2>Built around the way work actually moves.</h2>
          <p>
            Kasitek connects the customer journey—from the first message to the
            next campaign—inside one workspace.
          </p>
          <a className="button button-dark" href={appUrl}>
            Open Kasitek
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>

        <div className="operating-list">
          {operatingAreas.map((area) => (
            <article key={area.index} className="operating-row">
              <span className="operating-index">{area.index}</span>
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
          <div className="section-label">
            <span>03</span>
            <p>How we work</p>
          </div>
          <h2>Small team.<br />Clear decisions.<br />Real delivery.</h2>
        </div>

        <div className="process-list">
          {processSteps.map(([number, title, text]) => (
            <article key={number}>
              <span>{number}</span>
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
          <div className="section-label light-label">
            <span>04</span>
            <p>For agencies</p>
          </div>
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
          <span className="wordmark-symbol" aria-hidden="true">
            K<span>/</span>L
          </span>
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
