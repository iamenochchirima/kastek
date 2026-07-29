import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { appUrl, contactEmail } from "@/lib/site-config";

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
      </Link>

      <nav className="desktop-nav" aria-label="Main navigation">
        <a href={`${sectionPrefix}#work`}>What we build</a>
        <a href={`${sectionPrefix}#approach`}>How we work</a>
        <a href={`${sectionPrefix}#partners`}>Partners</a>
      </nav>

      <a
        className="header-cta"
        href={`mailto:${contactEmail}?subject=Project enquiry`}
      >
        Start a project
        <ArrowUpRight aria-hidden="true" />
      </a>

      <details className="mobile-nav">
        <summary>Menu</summary>
        <div className="mobile-nav-panel">
          <a href={`${sectionPrefix}#work`}>What we build</a>
          <a href={`${sectionPrefix}#approach`}>How we work</a>
          <a href={`${sectionPrefix}#partners`}>Partners</a>
          <a href={`mailto:${contactEmail}?subject=Project enquiry`}>
            Start a project
          </a>
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
          </Link>
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
            <Link href="/#work">Products</Link>
            <Link href="/#approach">Services</Link>
            <Link href="/#partners">Partnership</Link>
            <a href={`mailto:${contactEmail}?subject=Project enquiry`}>
              Start a project
            </a>
          </div>
          <div className="footer-column">
            <p>Kasitek</p>
            <a href={appUrl}>Open Kasitek</a>
            <Link href="/solutions">Solutions</Link>
            <Link href="/pricing">Pricing</Link>
          </div>
          <div className="footer-column">
            <p>Company</p>
            <Link href="/about">About</Link>
            <Link href="/meta-business-platform">Meta Platform</Link>
            <a href={`mailto:${contactEmail}`}>Contact</a>
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
