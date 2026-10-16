import { productUrls } from "@/lib/site-config";
import { LandingImage } from "./landing-image";

export function AgentsSection() {
  return (
    <section className="product-panel" id="agents" aria-labelledby="agents-title">
      <div className="product-label">
        <span className="productMark agentMark" aria-hidden="true">
        </span>
        {"KasiTek Agents"}
      </div>
      <div className="feature-heading">
        <h2 id="agents-title">
          {"For your customers."}
          <br />
          <em>
            {"Your business. And you."}
          </em>
        </h2>
        <div>
          <p>
            {"AI agents for customer support, business tasks and personal work. Each with the knowledge and tools for its job."}
          </p>
          <a className="text-action" href={productUrls.agents}>
            {"Explore Agents "}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M5 19 19 5M5 5h14v14">
              </path>
            </svg>
          </a>
        </div>
      </div>
      <div className="showcase-stage stage-agents agent-explorer">
        <div className="agent-playback" aria-label="Agent demo controls">
          <span className="demo-scene-label" data-agent-scene-label="">
            {"Customer support"}
          </span>
          <button type="button" data-agent-autoplay="" aria-pressed="false">
            <span data-autoplay-icon="" aria-hidden="true">
              {"Ⅱ"}
            </span>
            <span data-autoplay-label="">
              {"Pause sequence"}
            </span>
          </button>
          <button type="button" data-agent-next="">
            {"Next example "}
            <span aria-hidden="true">
              {"→"}
            </span>
          </button>
        </div>
        <div id="agent-demo" data-preview="agent" role="region" aria-label="Customer support example">
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
      </div>
      <p className="sr-only" data-agent-status="" role="status">
      </p>
      <div className="feature-foot">
        <p>
          {"One platform. Different ways to put it to work."}
        </p>
        <button className="replay-motion" type="button" data-replay="" aria-label="Replay product animation">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M3 10a9 9 0 1 1 1 7M3 4v6h6">
            </path>
          </svg>
          {"Replay animation"}
        </button>
      </div>
    </section>
  );
}
