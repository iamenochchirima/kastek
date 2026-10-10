import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, ChevronDown } from "lucide-react";
import { AgentPreview, AgencyPreview, GrowthPreview } from "./product-previews";
import styles from "./landing.module.css";

export const metadata: Metadata = {
  title: "KasiTek Labs | Agents, Growth & Agency",
  description: "AI agents, business growth tools and white-label workspaces, built by KasiTek Labs.",
  robots: { index: false, follow: false },
};

const products = [
  { id: "agents", name: "Agents", description: "AI that knows your business.", className: styles.agentMark },
  { id: "growth", name: "Growth", description: "Your daily business workspace.", className: styles.growthMark },
  { id: "agency", name: "Agency", description: "Client work, under your brand.", className: styles.agencyMark },
];

export default function LandingV2() {
  return (
    <main className={styles.page} id="top">
      <div className={styles.heroShell}>
        <header className={styles.header}>
          <Link href="/landingv2" className={styles.brand} aria-label="KasiTek Labs home">
            <Image src="/logo.png" alt="" width={35} height={35} />
            <span>KasiTek <small>Labs</small></span>
          </Link>
          <nav className={styles.nav} aria-label="Main navigation">
            <details className={styles.productMenu}>
              <summary>Products <ChevronDown size={13} /></summary>
              <div>{products.map(product => <a key={product.id} href={`#${product.id}`}><span className={`${styles.productMark} ${product.className}`} aria-hidden="true" /><span>{product.name}<small>{product.description}</small></span><ArrowUpRight size={15} /></a>)}</div>
            </details>
            <a href="#services">Services</a>
            <Link href="/about">About</Link>
          </nav>
          <Link href="/contact" className={styles.headerCta}>Let’s talk <ArrowUpRight size={15} /></Link>
        </header>

        <section className={styles.hero}>
          <Image src="/hero-mountain-study.jpg" alt="" fill priority sizes="100vw" className={styles.heroImage} />
          <div className={styles.heroContent}>
            <h1>Good ideas.<br />Real working <em>tools.</em></h1>
            <div className={styles.heroBottom}>
              <p>AI agents, business growth tools<br />and white-label workspaces.</p>
              <a href="#products" className={styles.heroLink}>Explore our products <span><ArrowDown size={18} /></span></a>
            </div>
          </div>
          <div className={styles.heroCredit}>KasiTek Labs <span>South Africa</span></div>
        </section>
      </div>

      <section className={styles.productDirectory} id="products" aria-label="Our products">
        {products.map(product => (
          <a key={product.id} href={`#${product.id}`} className={styles.directoryItem}>
            <span className={`${styles.productMark} ${product.className}`} aria-hidden="true" />
            <span><h2>{product.name}</h2><p>{product.description}</p></span>
            <ArrowUpRight size={21} strokeWidth={1.4} />
          </a>
        ))}
      </section>

      <section className={styles.agentsSection} id="agents">
        <div className={styles.productHeading}>
          <div className={styles.productName}><span className={`${styles.productMark} ${styles.agentMark}`} aria-hidden="true" />KasiTek Agents</div>
          <h2>Knows the details.<br /><em>Handles the questions.</em></h2>
          <div className={styles.headingAside}><p>An agent with your knowledge and tools.<br />Ready for your website, with your team close by.</p><Link className={styles.textLink} href="/early-access?product=agents">Discover Agents <ArrowUpRight size={17} /></Link></div>
        </div>
        <AgentPreview />
        <div className={styles.sectionFoot}><p>Your knowledge. Approved tools. Human handoff.</p><span>Website chat & team inbox</span></div>
      </section>

      <section className={styles.growthSection} id="growth">
        <div className={styles.growthCopy}>
          <div className={styles.productName}><span className={`${styles.productMark} ${styles.growthMark}`} aria-hidden="true" />KasiTek Growth</div>
          <h2>The business.<br /><em>All together.</em></h2>
          <p>The customer message. The next campaign. The post you meant to schedule. Keep the day’s work in one place.</p>
          <Link className={styles.textLink} href="/early-access?product=growth">Discover Growth <ArrowUpRight size={17} /></Link>
          <div className={styles.growthFeatures}><span>Contacts & inbox</span><span>Campaigns & content</span><span>Calendar & bookings</span></div>
        </div>
        <GrowthPreview />
      </section>

      <section className={styles.agencySection} id="agency">
        <div className={styles.agencyHeading}>
          <div><div className={styles.productName}><span className={`${styles.productMark} ${styles.agencyMark}`} aria-hidden="true" />KasiTek Agency</div><h2>A home for your clients.<br /><em>With your name on it.</em></h2></div>
          <div className={styles.headingAside}><p>Separate businesses, branded portals and the right access for each team and client.</p><Link className={styles.textLink} href="/contact?type=partnership">Discover Agency <ArrowUpRight size={17} /></Link></div>
        </div>
        <AgencyPreview />
      </section>

      <section className={styles.services} id="services">
        <div className={styles.servicesImage}><Image src="/images/service-delivery-editorial-v1.png" alt="" fill sizes="(max-width: 760px) 100vw, 45vw" /></div>
        <div className={styles.servicesCopy}><p className={styles.sectionLabel}>Built with Labs</p><h2>Some work calls<br />for something <em>specific.</em></h2><p>Custom software, integrations and hands-on delivery.<br />Tell us what you’re working on.</p><Link href="/get-quote?service=delivery" className={styles.textLink}>Start a project <ArrowUpRight size={18} /></Link></div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerTop}><Link href="/landingv2" className={styles.footerBrand}>KasiTek <em>Labs.</em></Link><Link href="/contact" className={styles.footerContact}>Have something in mind? <ArrowUpRight size={22} /></Link></div>
        <div className={styles.footerLinks}><p>Good ideas. Real working tools.</p><nav aria-label="Footer products">{products.map(product => <a key={product.id} href={`#${product.id}`}>{product.name}</a>)}</nav><nav aria-label="Company links"><Link href="/about">About</Link><Link href="/contact">Contact</Link><Link href="/privacy-policy">Privacy</Link></nav></div>
        <div className={styles.footerBottom}><span>© {new Date().getFullYear()} KasiTek Labs</span><span>Made in South Africa</span><a href="#top" aria-label="Back to top"><ArrowRight size={16} /></a></div>
      </footer>
    </main>
  );
}
