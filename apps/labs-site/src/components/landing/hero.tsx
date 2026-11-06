import Link from "next/link";
import { LandingImage } from "./landing-image";

export function Hero() {
  return (
    <section className="opening" aria-labelledby="hero-title">
      <LandingImage className="opening-image" src="/labs-landing/assets/service-delivery-editorial-v1.webp" alt="" fetchPriority="high" decoding="async" width="1672" height="941" />
      <header className="site-header container">
        <Link className="wordmark" href="/" aria-label="KasiTek Labs home">
          <LandingImage src="/labs-landing/assets/logo.png" alt="" width="29" height="29" decoding="async" />
          <span>
            {"KasiTek "}
            <small>
              {"Labs"}
            </small>
          </span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          <details className="productMenu">
            <summary>
              {"Products "}
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="m6 9 6 6 6-6">
                </path>
              </svg>
            </summary>
            <div>
              <a href="/waitlist">
                <b>
                  {"Agents"}
                </b>
                <small>
                  {"Support, business & personal"}
                </small>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M5 19 19 5M5 5h14v14">
                  </path>
                </svg>
              </a>
              <a href="/waitlist">
                <b>
                  {"Growth"}
                </b>
                <small>
                  {"Conversations & campaigns"}
                </small>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M5 19 19 5M5 5h14v14">
                  </path>
                </svg>
              </a>
              <a href="/waitlist">
                <b>
                  {"Agency"}
                </b>
                <small>
                  {"Client work, under your brand"}
                </small>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M5 19 19 5M5 5h14v14">
                  </path>
                </svg>
              </a>
            </div>
          </details>
          <a href="#studio">
            {"The studio"}
          </a>
          <Link href="/about">
            {"About us"}
          </Link>
        </nav>
        <Link className="button header-button" href="/contact">
          {"Let’s talk "}
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M5 19 19 5M5 5h14v14">
            </path>
          </svg>
        </Link>
      </header>
      <div className="opening-content container">
        <div className="opening-copy">
          <p className="eyebrow light">
            {"Software, with people in mind."}
          </p>
          <h1 id="hero-title">
            {"Good ideas."}
            <br />
            {"Real working "}
            <em>
              {"tools."}
            </em>
          </h1>
          <p className="opening-description">
            {"AI agents, business growth tools"}
            <br />
            {"and white-label workspaces."}
          </p>
          <a className="button button-signal" href="#product-directory">
            {"Explore our products "}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M5 19 19 5M5 5h14v14">
              </path>
            </svg>
          </a>
        </div>
      </div>
      <div className="opening-bottom container">
        <span>
          {"Built by KasiTek Labs"}
        </span>
        <a href="#products">
          {"A closer look "}
          <span aria-hidden="true">
            {"↓"}
          </span>
        </a>
        <span>
          {"Design & engineering"}
        </span>
      </div>
    </section>
  );
}
