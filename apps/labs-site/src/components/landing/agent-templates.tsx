import { productUrls } from "@/lib/site-config";
import { LandingImage } from "./landing-image";

export function AgentTemplates() {
  return (
    <>
    <div hidden inert data-agent-template="" id="agent-support">
      <div className="operation-demo support-demo" data-agent-scene="support">
        <LandingImage className="operation-photo" src="/labs-landing/assets/agents/working-studio.webp" alt="" loading="lazy" decoding="async" width="1536" height="1024" />
        <div className="operation-shade">
        </div>
        <div className="operation-caption">
          <span>
            {"Customer support"}
          </span>
          <h3>
            {"For the questions"}
            <br />
            <em>
              {"that need an answer."}
            </em>
          </h3>
          <p>
            {"A closer look at an agent doing the work."}
          </p>
        </div>
        <div className="operation-window">
          <header className="op-app-header">
            <a className="op-brand" href={productUrls.agents}>
              <LandingImage src="/labs-landing/assets/logo.png" alt="" width="20" height="20" decoding="async" />
              {"KasiTek "}
              <small>
                {"Agents"}
              </small>
            </a>
            <div className="op-header-right">
              <span>
                {"Illustrative demo"}
              </span>
              <button type="button" data-replay="" aria-label="Replay this agent operation">
                {"↻ Replay"}
              </button>
            </div>
          </header>
          <div className="op-app-body">
            <aside className="op-sidebar">
              <div className="op-sidebar-label">
                {"INBOX "}
                <span>
                  {"3"}
                </span>
              </div>
              <div className="op-contact is-current">
                <LandingImage className="op-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Customer profile" width="32" height="32" decoding="async" />
                <div>
                  <b>
                    {"Bella M."}
                  </b>
                  <span>
                    {"Returns & exchanges"}
                  </span>
                </div>
                <i>
                </i>
              </div>
              <div className="op-contact">
                <LandingImage className="op-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Customer profile" width="32" height="32" decoding="async" />
                <div>
                  <b>
                    {"Daniel S."}
                  </b>
                  <span>
                    {"Delivery update"}
                  </span>
                </div>
              </div>
              <div className="op-contact">
                <LandingImage className="op-avatar" src="/labs-landing/assets/agents/teammate.jpg" alt="Customer profile" width="32" height="32" decoding="async" />
                <div>
                  <b>
                    {"Sarah K."}
                  </b>
                  <span>
                    {"Thank you!"}
                  </span>
                </div>
              </div>
              <div className="op-sidebar-bottom">
                <span className="op-online">
                </span>
                {"Acorn agent is online"}
              </div>
            </aside>
            <section className="op-main">
              <header className="op-thread-header">
                <div>
                  <b>
                    {"Bella M."}
                  </b>
                  <span>
                    {"Website chat · Today"}
                  </span>
                </div>
                <span className="op-status">
                  {"Resolved"}
                </span>
              </header>
              <div className="op-thread">
                <span className="op-time-divider">
                  {"Today, 09:41"}
                </span>
                <div className="op-message op-incoming">
                  <LandingImage className="op-avatar" src="/labs-landing/assets/agents/customer.jpg" alt="Bella, sample customer" width="32" height="32" decoding="async" />
                  <div>
                    <b>
                      {"Bella "}
                      <time>
                        {"09:41"}
                      </time>
                    </b>
                    <p>
                      {"Hi, this bag arrived yesterday. Can I exchange it for a different colour?"}
                    </p>
                  </div>
                </div>
                <div className="op-order">
                  <LandingImage src="/labs-landing/assets/agents/product.jpg" alt="Sample handbag order" width="48" height="48" decoding="async" />
                  <div>
                    <b>
                      {"Order #AC-1082"}
                    </b>
                    <span>
                      {"Everyday bag · Delivered yesterday"}
                    </span>
                  </div>
                  <span>
                    {"↗"}
                  </span>
                </div>
                <div className="op-message op-response">
                  <span className="op-agent-avatar">
                    {"✳"}
                  </span>
                  <div>
                    <b>
                      {"Acorn agent "}
                      <time>
                        {"09:41"}
                      </time>
                    </b>
                    <p data-typed="Yes, you can exchange it within 30 days. Keep the bag unused and in its original packaging. Maya can help you choose the colour and arrange the exchange.">
                      {"Yes, you can exchange it within 30 days. Keep the bag unused and in its original packaging. Maya can help you choose the colour and arrange the exchange."}
                    </p>
                    <span className="op-source-chip">
                      {"▤ Returns & exchanges"}
                    </span>
                  </div>
                </div>
                <div className="op-human-note">
                  <LandingImage className="op-avatar" src="/labs-landing/assets/agents/teammate.jpg" alt="Maya, sample teammate" width="32" height="32" decoding="async" />
                  <span>
                    {"Maya joined the conversation"}
                  </span>
                  <time>
                    {"09:42"}
                  </time>
                </div>
              </div>
              <div className="op-composer">
                <span>
                  {"Reply to Bella…"}
                </span>
                <span className="op-send">
                  {"↑"}
                </span>
              </div>
            </section>
            <aside className="op-activity">
              <div className="op-activity-title">
                {"Activity "}
                <span className="op-live">
                  {"Live demo"}
                </span>
              </div>
              <p className="op-run-id">
                {"Run · AC-2048"}
              </p>
              <div className="op-log">
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"09:41:02"}
                  </time>
                  <b>
                    {"Message received"}
                  </b>
                  <p>
                    {"Website chat · Bella M."}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"09:41:03"}
                  </time>
                  <b>
                    {"Knowledge searched"}
                  </b>
                  <p>
                    {"Returns & exchanges · 1 source"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"09:41:04"}
                  </time>
                  <b>
                    {"Policy matched"}
                  </b>
                  <p>
                    {"30-day exchange window"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"09:41:06"}
                  </time>
                  <b>
                    {"Reply sent"}
                  </b>
                  <p>
                    {"Answered with a source"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"09:41:08"}
                  </time>
                  <b>
                    {"Human handoff"}
                  </b>
                  <p>
                    {"Assigned to Maya"}
                  </p>
                </div>
              </div>
              <div className="op-run-complete">
                <span>
                  {"✓"}
                </span>
                {" Run complete"}
                <small>
                  {"Result saved to this conversation"}
                </small>
              </div>
            </aside>
          </div>
          <div className="op-progress" aria-hidden="true">
          </div>
        </div>
        <span className="operation-footnote">
          {"Sample workspace · Acorn"}
        </span>
      </div>
    </div>
    <div hidden inert data-agent-template="" id="agent-business">
      <div className="operation-demo business-demo" data-agent-scene="business">
        <LandingImage className="operation-photo" src="/labs-landing/assets/agents/business-workshop.webp" alt="" loading="lazy" decoding="async" width="1536" height="1024" />
        <div className="operation-shade">
        </div>
        <div className="operation-caption">
          <span>
            {"Business agents"}
          </span>
          <h3>
            {"The work moves."}
            <br />
            <em>
              {"You stay in control."}
            </em>
          </h3>
          <p>
            {"A closer look at an agent doing the work."}
          </p>
        </div>
        <div className="operation-window">
          <header className="op-app-header">
            <a className="op-brand" href={productUrls.agents}>
              <LandingImage src="/labs-landing/assets/logo.png" alt="" width="20" height="20" decoding="async" />
              {"KasiTek "}
              <small>
                {"Agents"}
              </small>
            </a>
            <div className="op-header-right">
              <span>
                {"Illustrative demo"}
              </span>
              <button type="button" data-replay="" aria-label="Replay this agent operation">
                {"↻ Replay"}
              </button>
            </div>
          </header>
          <div className="op-app-body">
            <aside className="op-sidebar">
              <div className="op-sidebar-label">
                {"WORKSPACE"}
              </div>
              <div className="op-side-item">
                {"◷ "}
                <span>
                  {"Conversations"}
                </span>
              </div>
              <div className="op-side-item is-current">
                {"▦ "}
                <span>
                  {"Calendar"}
                </span>
              </div>
              <div className="op-side-item">
                {"▤ "}
                <span>
                  {"Knowledge"}
                </span>
              </div>
              <div className="op-side-item">
                {"↗ "}
                <span>
                  {"Connected tools"}
                </span>
              </div>
              <div className="op-sidebar-bottom">
                <LandingImage className="op-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Sample workspace owner" width="32" height="32" decoding="async" />
                <span>
                  {"Daniel"}
                  <br />
                  <small>
                    {"Acorn workspace"}
                  </small>
                </span>
              </div>
            </aside>
            <section className="op-main">
              <header className="op-thread-header">
                <div>
                  <b>
                    {"Acorn calendar"}
                  </b>
                  <span>
                    {"Thursday, 15 October"}
                  </span>
                </div>
                <span className="op-status">
                  {"Event created"}
                </span>
              </header>
              <div className="op-business-body">
                <div className="op-request-bar">
                  <LandingImage className="op-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Daniel, sample requester" width="32" height="32" decoding="async" />
                  <p>
                    {"Book our planning meeting for Thursday at 10. Allow 45 minutes."}
                  </p>
                </div>
                <div className="op-calendar">
                  <div className="op-calendar-day">
                    <span>
                      {"THURSDAY"}
                    </span>
                    <b>
                      {"15"}
                    </b>
                  </div>
                  <div className="op-calendar-grid">
                    <div>
                      <time>
                        {"09:00"}
                      </time>
                      <span>
                      </span>
                    </div>
                    <div>
                      <time>
                        {"10:00"}
                      </time>
                      <span className="op-calendar-event">
                        <b>
                          {"Acorn planning"}
                        </b>
                        <small>
                          {"10:00–10:45 · 45 min"}
                        </small>
                        <span className="op-event-people">
                          <LandingImage className="op-avatar" src="/labs-landing/assets/agents/owner.jpg" alt="Sample attendee" width="32" height="32" decoding="async" />
                          <LandingImage className="op-avatar" src="/labs-landing/assets/agents/teammate.jpg" alt="Sample attendee" width="32" height="32" decoding="async" />
                          <i>
                            {"+1"}
                          </i>
                        </span>
                      </span>
                    </div>
                    <div>
                      <time>
                        {"11:00"}
                      </time>
                      <span>
                      </span>
                    </div>
                    <div>
                      <time>
                        {"12:00"}
                      </time>
                      <span>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="op-approval">
                  <div>
                    <b>
                      {"Ready to add to your calendar"}
                    </b>
                    <span>
                      {"Acorn planning · Thursday, 10:00"}
                    </span>
                  </div>
                  <span className="op-approval-action" data-final-action="✓ Approved">
                    {"✓ Approved"}
                  </span>
                  <svg className="op-demo-cursor" viewBox="0 0 24 28" fill="currentColor" stroke="white" strokeWidth="1.5" aria-hidden="true">
                    <path d="m3 2 17 13-8 1-4 8z">
                    </path>
                  </svg>
                </div>
                <div className="op-success">
                  <span>
                    {"✓"}
                  </span>
                  <div>
                    <b>
                      {"Meeting created"}
                    </b>
                    <small>
                      {"Event AC-482 · Saved after approval"}
                    </small>
                  </div>
                </div>
              </div>
            </section>
            <aside className="op-activity">
              <div className="op-activity-title">
                {"Activity "}
                <span className="op-live">
                  {"Live demo"}
                </span>
              </div>
              <p className="op-run-id">
                {"Run · AC-2049"}
              </p>
              <div className="op-log">
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"10:02:11"}
                  </time>
                  <b>
                    {"Request received"}
                  </b>
                  <p>
                    {"Acorn planning · 45 minutes"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"10:02:12"}
                  </time>
                  <b>
                    {"Event prepared"}
                  </b>
                  <p>
                    {"Thursday, 15 October · 10:00"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"10:02:14"}
                  </time>
                  <b>
                    {"Approval requested"}
                  </b>
                  <p>
                    {"Waiting for your review"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"10:02:17"}
                  </time>
                  <b>
                    {"Approved by Daniel"}
                  </b>
                  <p>
                    {"Calendar action authorised"}
                  </p>
                </div>
                <div className="op-step">
                  <span className="op-step-dot">
                  </span>
                  <time>
                    {"10:02:18"}
                  </time>
                  <b>
                    {"Event created"}
                  </b>
                  <p>
                    {"Receipt · AC-482"}
                  </p>
                </div>
              </div>
              <div className="op-run-complete">
                <span>
                  {"✓"}
                </span>
                {" Run complete"}
                <small>
                  {"Result saved to this conversation"}
                </small>
              </div>
            </aside>
          </div>
          <div className="op-progress" aria-hidden="true">
          </div>
        </div>
        <span className="operation-footnote">
          {"Sample workspace · Acorn"}
        </span>
      </div>
    </div>
    <div hidden inert data-agent-template="" id="agent-personal">
      <div className="operation-demo personal-mobile-demo" data-agent-scene="personal">
        <LandingImage className="operation-photo" src="/labs-landing/assets/agents/personal-at-home.webp" alt="" loading="lazy" decoding="async" width="1536" height="1024" />
        <div className="operation-shade">
        </div>
        <div className="operation-caption">
          <span>
            {"Personal agents"}
          </span>
          <h3>
            {"A little less"}
            <br />
            <em>
              {"on your mind."}
            </em>
          </h3>
          <p>
            {"Your notes, your plans, and an assistant you can take with you."}
          </p>
        </div>
        <div className="personal-outcome">
          <span className="outcome-eyebrow">
            {"YOUR DAY, A LITTLE CLEARER"}
          </span>
          <div className="personal-file-card">
            <span className="personal-file-icon">
              {"▤"}
            </span>
            <div>
              <b>
                {"Tomorrow’s meeting brief"}
              </b>
              <span>
                {"Built from your notes"}
              </span>
            </div>
          </div>
          <div className="personal-check">
            <span>
              {"✓"}
            </span>
            <p>
              {"Project notes read"}
            </p>
            <time>
              {"08:30:02"}
            </time>
          </div>
          <div className="personal-check">
            <span>
              {"✓"}
            </span>
            <p>
              {"Open questions gathered"}
            </p>
            <time>
              {"08:30:04"}
            </time>
          </div>
          <div className="personal-check">
            <span>
              {"✓"}
            </span>
            <p>
              {"Brief ready to read"}
            </p>
            <time>
              {"08:30:07"}
            </time>
          </div>
          <span className="personal-outcome-note">
            {"Your material stays in your space."}
          </span>
        </div>
        <div className="personal-phone">
          <div className="phone-island" aria-hidden="true">
          </div>
          <div className="phone-screen">
            <div className="phone-statusbar">
              <span>
                {"8:30"}
              </span>
              <div aria-hidden="true">
                {"▮▮▮ "}
                <span>
                  {"◔"}
                </span>
                {" ▰"}
              </div>
            </div>
            <header className="phone-agent-header">
              <span className="phone-back" aria-hidden="true">
                {"‹"}
              </span>
              <span className="phone-agent-symbol">
                {"✳"}
              </span>
              <div>
                <b>
                  {"Your personal agent"}
                </b>
                <span className="op-status">
                  {"Brief ready"}
                </span>
              </div>
              <button type="button" data-replay="" aria-label="Replay personal agent demo">
                {"↻"}
              </button>
            </header>
            <div className="phone-chat" tabIndex={0} role="region" aria-label="Personal agent conversation">
              <span className="phone-date">
                {"Tomorrow, made a little easier."}
              </span>
              <div className="phone-context">
                <span>
                  {"▤ Project notes.md"}
                </span>
                <span>
                  {"▤ Questions.txt"}
                </span>
              </div>
              <div className="phone-user-message">
                <LandingImage src="/labs-landing/assets/agents/teammate.jpg" alt="Sample personal agent user" width="24" height="24" decoding="async" />
                <p>
                  {"Help me get ready for tomorrow’s project meeting."}
                </p>
                <time>
                  {"08:30"}
                </time>
              </div>
              <div className="phone-agent-message">
                <span className="phone-inline-agent">
                  {"✳"}
                </span>
                <p data-typed="Your project is ready for review. I’ve gathered the decisions and your open questions into a short brief for tomorrow.">
                  {"Your project is ready for review. I’ve gathered the decisions and your open questions into a short brief for tomorrow."}
                </p>
              </div>
              <article className="phone-brief">
                <div className="phone-brief-meta">
                  <span>
                    {"MEETING BRIEF"}
                  </span>
                  <span>
                    {"↗"}
                  </span>
                </div>
                <h3>
                  {"Website launch."}
                  <br />
                  <em>
                    {"The short version."}
                  </em>
                </h3>
                <div className="phone-brief-line">
                  <b>
                    {"Decide"}
                  </b>
                  <p>
                    {"Final copy and launch date."}
                  </p>
                </div>
                <div className="phone-brief-line">
                  <b>
                    {"Next step"}
                  </b>
                  <p>
                    {"Share feedback before Friday."}
                  </p>
                </div>
                <div className="phone-brief-footer">
                  <span>
                    {"Saved to your files"}
                  </span>
                  <span>
                    {"✓"}
                  </span>
                </div>
              </article>
              <span className="phone-delivered">
                {"Ready for you to read and edit · 08:30"}
              </span>
            </div>
            <div className="phone-composer">
              <span>
                {"Ask me something…"}
              </span>
              <span className="phone-mic" aria-hidden="true">
                <i>
                </i>
                <i>
                </i>
                <i>
                </i>
                <i>
                </i>
                <i>
                </i>
              </span>
            </div>
            <div className="phone-home-indicator" aria-hidden="true">
            </div>
          </div>
        </div>
        <span className="operation-footnote">
          {"Illustrative personal experience · In development"}
        </span>
      </div>
    </div>
    </>
  );
}
