import type { CSSProperties } from "react";
import { productUrls } from "@/lib/site-config";
import { LandingImage } from "./landing-image";

export function GrowthSection() {
  return (
    <section className="product-panel" id="growth" aria-labelledby="growth-title">
      <div className="product-label">
        <span className="productMark growthMark" aria-hidden="true">
        </span>
        {"KasiTek Growth"}
      </div>
      <div className="feature-heading">
        <h2 id="growth-title">
          {"The business."}
          <br />
          <em>
            {"All together."}
          </em>
        </h2>
        <div>
          <p>
            {"Conversations, campaigns and the day's work, in one place."}
          </p>
          <a className="button button-signal" href={productUrls.growth}>
            {"Open Growth ↗"}
          </a>
        </div>
      </div>
      <div className="gr-demo pr-sequence" data-sequence="growth" data-state="conversation" role="region" aria-label="Illustrative Growth workspace">
        <LandingImage className="gr-backdrop" src="/labs-landing/assets/presentations/growth-shop.webp" alt="" loading="lazy" decoding="async" width="1672" height="941" />
        <div className="gr-window">
          <header className="gr-header">
            <b>
              {"K"}
              <span>
                {"."}
              </span>
            </b>
            <span>
              {"KasiTek Growth"}
            </span>
            <span className="gr-workspace">
              {"Acorn Home⌄"}
            </span>
            <span className="gr-search">
              {"⌕   Search"}
            </span>
            <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Sample workspace owner" width="32" height="32" decoding="async" />
          </header>
          <div className="gr-layout">
            <nav className="gr-sidebar" aria-label="Growth demo views">
              <button type="button" data-sequence-select="0" aria-pressed="true">
                {"▱ "}
                <span>
                  {"Inbox"}
                </span>
              </button>
              <span>
                {"♧ Contacts"}
              </span>
              <button type="button" data-sequence-select="1" aria-pressed="false">
                {"↗ "}
                <span>
                  {"Campaigns"}
                </span>
              </button>
              <button type="button" data-sequence-select="2" aria-pressed="false">
                {"▤ "}
                <span>
                  {"Content"}
                </span>
              </button>
              <span>
                {"▦ Calendar"}
              </span>
            </nav>
            <div className="gr-content">
              <div className="gr-view is-active" data-sequence-view="conversation">
                <div className="gr-inbox">
                  <aside className="gr-contacts">
                    <h3>
                      {"Inbox"}
                    </h3>
                    <div className="gr-filter">
                      {"All "}
                      <span>
                        {"Unread"}
                      </span>
                    </div>
                    <div className="gr-contact selected">
                      <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Jamie, sample customer" width="32" height="32" decoding="async" />
                      <div>
                        <b>
                          {"Jamie R."}
                        </b>
                        <small>
                          {"Will the new collection…"}
                        </small>
                      </div>
                      <i>
                      </i>
                    </div>
                    <div className="gr-contact">
                      <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" alt="Taylor, sample customer" width="32" height="32" decoding="async" />
                      <div>
                        <b>
                          {"Taylor M."}
                        </b>
                        <small>
                          {"My order arrived. Thank you!"}
                        </small>
                      </div>
                    </div>
                    <div className="gr-contact">
                      <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Morgan, sample customer" width="32" height="32" decoding="async" />
                      <div>
                        <b>
                          {"Morgan L."}
                        </b>
                        <small>
                          {"Do you offer gift wrapping?"}
                        </small>
                      </div>
                    </div>
                  </aside>
                  <div className="gr-thread">
                    <header>
                      <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Jamie, sample customer" width="32" height="32" decoding="async" />
                      <div>
                        <b>
                          {"Jamie R."}
                        </b>
                        <small>
                          {"Customer · Acorn Home"}
                        </small>
                      </div>
                      <span>
                        {"···"}
                      </span>
                    </header>
                    <span className="gr-today">
                      {"Today"}
                    </span>
                    <div className="gr-chat gr-customer pr-enter" style={{"--delay": ".6s"} as CSSProperties}>
                      <p>
                        {"Will the new collection be available this week?"}
                      </p>
                      <small>
                        {"14:14"}
                      </small>
                    </div>
                    <div className="gr-chat gr-reply pr-enter" style={{"--delay": "2.1s"} as CSSProperties}>
                      <p>
                        {"Yes, Thursday. Would you like an update when it arrives?"}
                      </p>
                      <small>
                        {"14:16 ✓"}
                      </small>
                    </div>
                    <div className="gr-composer">
                      <span>
                        {"Write a message…"}
                      </span>
                      <span className="gr-send">
                        {"↗"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="gr-view" data-sequence-view="campaign" hidden inert>
                <div className="gr-campaign">
                  <div className="gr-editor">
                    <header>
                      <h3>
                        {"New collection"}
                      </h3>
                      <span>
                        {"Draft"}
                      </span>
                    </header>
                    <div className="gr-field">
                      <small>
                        {"Campaign name"}
                      </small>
                      <p>
                        {"Thursday collection"}
                      </p>
                    </div>
                    <div className="gr-field pr-enter" style={{"--delay": ".5s"} as CSSProperties}>
                      <small>
                        {"Audience"}
                      </small>
                      <p>
                        {"♧ Collection updates "}
                        <span>
                          {"⌄"}
                        </span>
                      </p>
                    </div>
                    <div className="gr-field pr-enter" style={{"--delay": "1s"} as CSSProperties}>
                      <small>
                        {"Subject"}
                      </small>
                      <p>
                        {"A few new things for your home."}
                      </p>
                    </div>
                    <div className="gr-field pr-enter" style={{"--delay": "1.5s"} as CSSProperties}>
                      <small>
                        {"Content"}
                      </small>
                      <p>
                        {"Our new collection arrives Thursday. Handmade pieces for everyday rituals."}
                      </p>
                    </div>
                    <div className="gr-review">
                      <button type="button" data-sequence-next="">
                        {"Review campaign"}
                      </button>
                      <small>
                        {"Saved just now"}
                      </small>
                      <span className="gr-cursor" aria-hidden="true">
                        {"➤"}
                      </span>
                    </div>
                  </div>
                  <article className="gr-email pr-enter" style={{"--delay": ".8s"} as CSSProperties}>
                    <small>
                      {"ACORN HOME"}
                    </small>
                    <LandingImage src="/labs-landing/assets/presentations/ceramics.webp" alt="Handmade ceramic collection" loading="lazy" decoding="async" width="1536" height="1024" />
                    <h3>
                      {"Made for your "}
                      <br />
                      <em>
                        {"everyday."}
                      </em>
                    </h3>
                    <p>
                      {"Meet the new collection."}
                    </p>
                    <span className="gr-email-button">
                      {"View collection"}
                    </span>
                  </article>
                </div>
              </div>
              <div className="gr-view" data-sequence-view="schedule" hidden inert>
                <div className="gr-calendar">
                  <header>
                    <h3>
                      {"This week's plan"}
                    </h3>
                    <span>
                      {"Week "}
                      <small>
                        {"Month"}
                      </small>
                    </span>
                  </header>
                  <div className="gr-days">
                    <div className="gr-day">
                      <b>
                        {"MON "}
                        <span>
                          {"12"}
                        </span>
                      </b>
                      <article className="gr-event pr-enter" style={{"--delay": ".3s"} as CSSProperties}>
                        <time>
                          {"09:00"}
                        </time>
                        <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Sample customer" width="32" height="32" decoding="async" />
                        <h4>
                          {"Customer updates"}
                        </h4>
                        <p>
                          {"Inbox · 3 conversations"}
                        </p>
                      </article>
                    </div>
                    <div className="gr-day">
                      <b>
                        {"TUE "}
                        <span>
                          {"13"}
                        </span>
                      </b>
                      <article className="gr-event pr-enter" style={{"--delay": ".7s"} as CSSProperties}>
                        <time>
                          {"10:00"}
                        </time>
                        <LandingImage className="gr-event-photo" src="/labs-landing/assets/presentations/ceramics.webp" alt="Collection preview" loading="lazy" decoding="async" width="1536" height="1024" />
                        <h4>
                          {"Collection preview"}
                        </h4>
                        <p>
                          {"Social post · Scheduled"}
                        </p>
                      </article>
                    </div>
                    <div className="gr-day gr-empty">
                      <b>
                        {"WED "}
                        <span>
                          {"14"}
                        </span>
                      </b>
                      <p>
                        {"▦"}
                        <br />
                        {"Room for the day's work"}
                      </p>
                    </div>
                    <div className="gr-day">
                      <b>
                        {"THU "}
                        <span>
                          {"15"}
                        </span>
                      </b>
                      <article className="gr-event pr-enter" style={{"--delay": "1.2s"} as CSSProperties}>
                        <time>
                          {"09:00"}
                        </time>
                        <LandingImage className="gr-event-photo" src="/labs-landing/assets/presentations/ceramics.webp" alt="Thursday collection" loading="lazy" decoding="async" width="1536" height="1024" />
                        <h4>
                          {"Thursday collection"}
                        </h4>
                        <p>
                          {"Email campaign · Scheduled"}
                        </p>
                      </article>
                      <article className="gr-event gr-social pr-enter" style={{"--delay": "1.8s"} as CSSProperties}>
                        <time>
                          {"09:15"}
                        </time>
                        <h4>
                          {"New collection is here"}
                        </h4>
                        <p>
                          {"Social post · Scheduled"}
                        </p>
                      </article>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="gr-note">
          <div data-growth-note="conversation">
            <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Sample customer" width="32" height="32" decoding="async" />
            <div>
              <b>
                {"New conversation"}
              </b>
              <p>
                {"A customer, ready for the next collection."}
              </p>
            </div>
          </div>
          <div data-growth-note="campaign" hidden>
            <div className="gr-avatar-stack">
              <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Sample team member" width="32" height="32" decoding="async" />
              <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/teammate.jpg" alt="Sample team member" width="32" height="32" decoding="async" />
              <LandingImage className="pr-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Sample team member" width="32" height="32" decoding="async" />
            </div>
            <div>
              <b>
                {"Collection updates"}
              </b>
              <p>
                {"Customers who asked to hear more."}
              </p>
            </div>
          </div>
          <div data-growth-note="schedule" hidden>
            <span className="gr-note-check">
              {"✓"}
            </span>
            <div>
              <b>
                {"The collection is scheduled."}
              </b>
              <p>
                {"Email and social. Ready for Thursday."}
              </p>
            </div>
          </div>
        </div>
        <p className="gr-caption">
          {"The next step starts with a conversation."}
        </p>
        <span className="gr-sample">
          {"Illustrative workspace"}
        </span>
      </div>
      <p className="sr-only" data-sequence-status="" role="status">
      </p>
    </section>
  );
}
