import type { CSSProperties } from "react";
import { productUrls } from "@/lib/site-config";
import { LandingImage } from "./landing-image";

export function AgencySection() {
  return (
    <section className="product-panel" id="agency" aria-labelledby="agency-title">
      <div className="agency-demo pr-sequence" data-sequence="agency" data-state="portfolio" data-front="acorn" role="region" aria-label="Illustrative Agency client portals">
        <div className="agency-editorial">
          <span className="agency-kicker">
            <span className="productMark agencyMark" aria-hidden="true">
            </span>
            {"KasiTek Agency"}
          </span>
          <h2 id="agency-title">
            {"Your clients."}
            <br />
            {"Your "}
            <em>
              {"signature."}
            </em>
          </h2>
          <p>
            {"Client portals, in your studio's name."}
            <br />
            {"Keep the work and feedback together."}
          </p>
          <a className="agency-enquire" href={productUrls.agency}>
            {"Explore Agency "}
            <span aria-hidden="true">
              {"↗"}
            </span>
          </a>
        </div>
        <div className="agency-identity" data-agency-identity="">
          <span className="agency-identity-caption">
            {"Your studio, everywhere."}
          </span>
          <div className="agency-brand-row">
            <span className="agency-brand-name">
              {"north"}
              <span>
                {"."}
              </span>
            </span>
            <div className="agency-swatches" role="group" aria-label="Portal accent">
              <button type="button" data-accent="#e76b49" style={{"--swatch": "#e76b49"} as CSSProperties} aria-label="Coral accent" aria-pressed="true">
                {"✓"}
              </button>
              <button type="button" data-accent="#6f7695" style={{"--swatch": "#6f7695"} as CSSProperties} aria-label="Slate accent" aria-pressed="false">
              </button>
              <button type="button" data-accent="#b99b79" style={{"--swatch": "#b99b79"} as CSSProperties} aria-label="Sand accent" aria-pressed="false">
              </button>
            </div>
          </div>
          <span className="agency-brand-status" data-brand-status="">
            {"One identity. Every client portal."}
          </span>
        </div>
        <div className="agency-client-tabs" role="group" aria-label="Choose a client portal">
          <button type="button" data-client="acorn" aria-pressed="true">
            <i style={{"--client-colour": "#c77b55"} as CSSProperties}>
            </i>
            <span>
              {"Acorn Home"}
            </span>
          </button>
          <button type="button" data-client="dental" aria-pressed="false">
            <i style={{"--client-colour": "#6f7695"} as CSSProperties}>
            </i>
            <span>
              {"Kaya Dental"}
            </span>
          </button>
          <button type="button" data-client="lena" aria-pressed="false">
            <i style={{"--client-colour": "#b99b79"} as CSSProperties}>
            </i>
            <span>
              {"Lena Studio"}
            </span>
          </button>
        </div>
        <div className="agency-windows">
          <article className="agency-portal agency-window" data-depth="front" data-portal="acorn" aria-hidden="false" aria-label="Acorn Home client portal">
            <header className="agency-chrome">
              <span className="agency-studio-wordmark">
                {"north"}
                <span>
                  {"."}
                </span>
              </span>
              <span className="agency-chrome-label">
                {"Acorn Home"}
              </span>
              <span className="agency-chrome-mark" aria-hidden="true">
                {"↗"}
              </span>
            </header>
            <div className="agency-portal-content">
              <div className="agency-welcome">
                <div>
                  <span className="agency-client-name">
                    {"Acorn Home"}
                  </span>
                  <h3>
                    {"Welcome back, "}
                    <em>
                      {"Alex."}
                    </em>
                  </h3>
                </div>
                <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" width="32" height="32" alt="Sample client" decoding="async" />
              </div>
              <div className="agency-project" data-review-state="idle">
                <div className="agency-project-art">
                  <LandingImage src="/labs-landing/assets/presentations/ceramics.webp" alt="Thursday collection preview" width="1536" height="1024" loading="lazy" decoding="async" />
                  <span className="agency-file-label">
                    {"Thursday collection"}
                    <small>
                      {"Preview · Shared today"}
                    </small>
                  </span>
                  <span className="agency-art-check" aria-hidden="true">
                    {"✓"}
                  </span>
                </div>
                <div className="agency-project-copy">
                  <span className="agency-project-status">
                    <i>
                    </i>
                    <span data-review-status="">
                      {"Ready for review"}
                    </span>
                  </span>
                  <h4>
                    {"Thursday collection"}
                  </h4>
                  <p>
                    {"A few new pieces. Ready for their first impression."}
                  </p>
                  <div className="agency-sender">
                    <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" width="32" height="32" alt="Maya, sample account manager" decoding="async" />
                    <span>
                      {"Maya Jacobs"}
                      <small>
                        {"Shared with you today"}
                      </small>
                    </span>
                  </div>
                  <button className="agency-review" type="button" data-agency-review="">
                    {"Review preview "}
                    <span aria-hidden="true">
                      {"↗"}
                    </span>
                  </button>
                </div>
              </div>
              <div className="agency-portal-footer">
                <span className="agency-file-icon" aria-hidden="true">
                  {"▤"}
                </span>
                <span>
                  {"Weekly summary"}
                  <small>
                    {"Your latest report"}
                  </small>
                </span>
                <span className="agency-report-link">
                  {"View report ↗"}
                </span>
              </div>
            </div>
            <div className="agency-window-foot">
              <span className="agency-private-dot" aria-hidden="true">
              </span>
              <span>
                {"Shared with your team."}
              </span>
              <span className="agency-window-wordmark">
                {"North Studio"}
              </span>
            </div>
          </article>
          <article className="agency-portal agency-window" data-depth="top" data-portal="dental" aria-hidden="true" inert aria-label="Kaya Dental client portal">
            <header className="agency-chrome">
              <span className="agency-studio-wordmark">
                {"north"}
                <span>
                  {"."}
                </span>
              </span>
              <span className="agency-chrome-label">
                {"Kaya Dental"}
              </span>
              <span className="agency-chrome-mark" aria-hidden="true">
                {"↗"}
              </span>
            </header>
            <div className="agency-portal-content">
              <div className="agency-welcome">
                <div>
                  <span className="agency-client-name">
                    {"Kaya Dental"}
                  </span>
                  <h3>
                    {"Welcome back, "}
                    <em>
                      {"Jordan."}
                    </em>
                  </h3>
                </div>
                <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/owner.jpg" width="32" height="32" alt="Sample client" decoding="async" />
              </div>
              <div className="agency-project" data-review-state="idle">
                <div className="agency-project-art">
                  <LandingImage src="/labs-landing/assets/presentations/dental.webp" alt="A fresh welcome preview" width="1536" height="1024" loading="lazy" decoding="async" />
                  <span className="agency-file-label">
                    {"A fresh welcome"}
                    <small>
                      {"Preview · Shared today"}
                    </small>
                  </span>
                  <span className="agency-art-check" aria-hidden="true">
                    {"✓"}
                  </span>
                </div>
                <div className="agency-project-copy">
                  <span className="agency-project-status">
                    <i>
                    </i>
                    <span data-review-status="">
                      {"Ready for review"}
                    </span>
                  </span>
                  <h4>
                    {"A fresh welcome"}
                  </h4>
                  <p>
                    {"Your new website, ready for a closer look."}
                  </p>
                  <div className="agency-sender">
                    <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" width="32" height="32" alt="Maya, sample account manager" decoding="async" />
                    <span>
                      {"Maya Jacobs"}
                      <small>
                        {"Shared with you today"}
                      </small>
                    </span>
                  </div>
                  <button className="agency-review" type="button" data-agency-review="">
                    {"Review preview "}
                    <span aria-hidden="true">
                      {"↗"}
                    </span>
                  </button>
                </div>
              </div>
              <div className="agency-portal-footer">
                <span className="agency-file-icon" aria-hidden="true">
                  {"▤"}
                </span>
                <span>
                  {"Weekly summary"}
                  <small>
                    {"Your latest report"}
                  </small>
                </span>
                <span className="agency-report-link">
                  {"View report ↗"}
                </span>
              </div>
            </div>
            <div className="agency-window-foot">
              <span className="agency-private-dot" aria-hidden="true">
              </span>
              <span>
                {"Shared with your team."}
              </span>
              <span className="agency-window-wordmark">
                {"North Studio"}
              </span>
            </div>
          </article>
          <article className="agency-portal agency-window" data-depth="bottom" data-portal="lena" aria-hidden="true" inert aria-label="Lena Studio client portal">
            <header className="agency-chrome">
              <span className="agency-studio-wordmark">
                {"north"}
                <span>
                  {"."}
                </span>
              </span>
              <span className="agency-chrome-label">
                {"Lena Studio"}
              </span>
              <span className="agency-chrome-mark" aria-hidden="true">
                {"↗"}
              </span>
            </header>
            <div className="agency-portal-content">
              <div className="agency-welcome">
                <div>
                  <span className="agency-client-name">
                    {"Lena Studio"}
                  </span>
                  <h3>
                    {"Welcome back, "}
                    <em>
                      {"Sam."}
                    </em>
                  </h3>
                </div>
                <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" width="32" height="32" alt="Sample client" decoding="async" />
              </div>
              <div className="agency-project" data-review-state="idle">
                <div className="agency-project-art">
                  <LandingImage src="/labs-landing/assets/presentations/lena.webp" alt="The new identity preview" width="1536" height="1024" loading="lazy" decoding="async" />
                  <span className="agency-file-label">
                    {"The new identity"}
                    <small>
                      {"Preview · Shared today"}
                    </small>
                  </span>
                  <span className="agency-art-check" aria-hidden="true">
                    {"✓"}
                  </span>
                </div>
                <div className="agency-project-copy">
                  <span className="agency-project-status">
                    <i>
                    </i>
                    <span data-review-status="">
                      {"Ready for review"}
                    </span>
                  </span>
                  <h4>
                    {"The new identity"}
                  </h4>
                  <p>
                    {"The finishing touches, brought together."}
                  </p>
                  <div className="agency-sender">
                    <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" width="32" height="32" alt="Maya, sample account manager" decoding="async" />
                    <span>
                      {"Maya Jacobs"}
                      <small>
                        {"Shared with you today"}
                      </small>
                    </span>
                  </div>
                  <button className="agency-review" type="button" data-agency-review="">
                    {"Review preview "}
                    <span aria-hidden="true">
                      {"↗"}
                    </span>
                  </button>
                </div>
              </div>
              <div className="agency-portal-footer">
                <span className="agency-file-icon" aria-hidden="true">
                  {"▤"}
                </span>
                <span>
                  {"Weekly summary"}
                  <small>
                    {"Your latest report"}
                  </small>
                </span>
                <span className="agency-report-link">
                  {"View report ↗"}
                </span>
              </div>
            </div>
            <div className="agency-window-foot">
              <span className="agency-private-dot" aria-hidden="true">
              </span>
              <span>
                {"Shared with your team."}
              </span>
              <span className="agency-window-wordmark">
                {"North Studio"}
              </span>
            </div>
          </article>
        </div>
        <div className="agency-stage-foot">
          <span>
            {"A separate workspace for every client."}
          </span>
          <span>
            {"Illustrative client portal"}
          </span>
        </div>
      </div>
      <div className="pr-controls">
        <span className="demo-scene-label" data-sequence-label="">
          {"Client workspaces"}
        </span>
        <button type="button" data-sequence-pause="" aria-pressed="false">
          {"Ⅱ "}
          <span>
            {"Pause"}
          </span>
        </button>
        <button type="button" data-sequence-next="">
          {"Next view →"}
        </button>
        <button type="button" data-sequence-replay="" aria-label="Replay this section">
          {"↻ Replay"}
        </button>
      </div>
      <p className="sr-only" data-sequence-status="" role="status">
      </p>
    </section>
  );
}
