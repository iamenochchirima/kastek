import Image from "next/image";
import Link from "next/link";
import { appUrl } from "@/lib/site-config";

type LabsHeaderProps = {
  home?: boolean;
  tone?: "dark" | "light";
};

export function LabsHeader({ home = false, tone = "dark" }: LabsHeaderProps) {
  const sectionPrefix = home ? "" : "/";

  return (
    <header className={`site-header${tone === "light" ? " inner-site-header" : ""}`}>
      <Link
        className="wordmark"
        href={home ? "#top" : "/"}
        aria-label="Kasitek Labs home"
      >
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
        <span className="beta-tag">Beta</span>
      </Link>

      <nav className="desktop-nav" aria-label="Main navigation">
        <a href={`${sectionPrefix}#kasitek`}>Platform</a>
        <a href={`${sectionPrefix}#approach`}>Services</a>
        <a href={`${sectionPrefix}#partners`}>Partnership</a>
        <Link href="/pricing">Pricing</Link>
        <Link href="/get-quote">Get a quote</Link>
      </nav>

      <div className="header-actions">
        <Link className="header-cta" href="/early-access">
          Early access
        </Link>
        {/* <a className="header-cta" href={appUrl} target="_blank" rel="noreferrer">Get started</a> */}
      </div>

      <details className="mobile-nav">
        <summary>Menu</summary>
        <div className="mobile-nav-panel">
          <a href={`${sectionPrefix}#kasitek`}>Platform</a>
          <a href={`${sectionPrefix}#approach`}>Services</a>
          <a href={`${sectionPrefix}#partners`}>Partnership</a>
          <Link href="/pricing">Pricing</Link>
          <Link href="/early-access">Early access</Link>
          <Link href="/get-quote">Get a quote</Link>
          {/* <a href={appUrl} target="_blank" rel="noreferrer">Get started ↗</a> */}
        </div>
      </details>
    </header>
  );
}

export function LabsFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-primary">
        <div className="footer-brand">
          <Link
            className="wordmark footer-wordmark"
            href="/"
            aria-label="Kasitek Labs home"
          >
            <Image
              className="brand-mark"
              src="/logo.png"
              alt=""
              width={40}
              height={40}
            />
            <span className="wordmark-name">
              Kasitek
              <small>Labs</small>
            </span>
            <span className="beta-tag">Beta</span>
          </Link>
          <p>
            AI products, delivery and infrastructure for business operations.
          </p>
        </div>

        <nav className="footer-nav" aria-label="Footer navigation">
          <div className="footer-column">
            <p>Work with us</p>
            <Link href="/#kasitek">Platform</Link>
            <Link href="/#approach">Services</Link>
            <Link href="/#partners">Partnership</Link>
            <Link href="/get-quote">Request a quote</Link>
          </div>
          <div className="footer-column">
            <p>Platform</p>
            <Link href="/#kasitek">Overview</Link>
            <Link href="/pricing">Pricing</Link>
            <a href={appUrl} target="_blank" rel="noreferrer">
              Open Kasitek app ↗
            </a>
          </div>
          <div className="footer-column">
            <p>Company</p>
            <Link href="/about">About</Link>
            <Link href="/meta-business-platform">Meta Platform</Link>
            <Link href="/contact">Contact</Link>
          </div>
          <div className="footer-column">
            <p>Legal</p>
            <Link href="/privacy-policy">Privacy</Link>
            <Link href="/terms">Terms of Service</Link>
            <Link href="/data-deletion">Data Deletion</Link>
          </div>
        </nav>
      </div>

      <div className="footer-bottom">
        <p>© {new Date().getFullYear()} Kasitek Labs</p>
        <p>South Africa</p>
        <a href="#top">Back to top ↑</a>
      </div>
    </footer>
  );
}

export function LabsInnerShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="labs-page inner-page" id="top">
      <LabsHeader tone="light" />
      {children}
      <LabsFooter />
    </main>
  );
}
