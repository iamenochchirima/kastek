import Link from "next/link";
import { LandingImage } from "./landing-image";

export function Footer() {
  return (
    <footer className="site-footer container">
      <div className="footer-main">
        <Link className="wordmark" href="/">
          <LandingImage src="/labs-landing/assets/logo.png" alt="" width="30" height="30" decoding="async" />
          <span>
            {"KasiTek "}
            <small>
              {"Labs"}
            </small>
          </span>
        </Link>
        <p>
          {"Good ideas. Real working tools."}
        </p>
        <nav aria-label="Footer products">
          <a href="/waitlist">
            {"Agents"}
          </a>
          <a href="/waitlist">
            {"Growth"}
          </a>
          <a href="/waitlist">
            {"Agency"}
          </a>
        </nav>
        <nav aria-label="Company links">
          <Link href="/about">
            {"About"}
          </Link>
          <Link href="/contact">
            {"Contact"}
          </Link>
          <Link href="/privacy-policy">
            {"Privacy"}
          </Link>
        </nav>
      </div>
      <div className="footer-bottom">
        <span data-copyright="">
          © {new Date().getFullYear()} KasiTek Labs
        </span>
        <a href="#top">
          {"Back to top ↑"}
        </a>
        <span>
          {"Independent software studio"}
        </span>
      </div>
    </footer>
  );
}
