import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { AgentSettingsPreview, BusinessPreview, PersonalPreview, WebsitePreview } from "./landing-v2-previews";
import "./landing-v2.css";

const signup = "/signup?returnTo=%2Fapp%2Fagents";

function AgentMark() {
  return <svg width="23" height="27" viewBox="0 0 23 27" fill="none" aria-hidden="true"><path d="M3 24V11a8.5 8.5 0 0 1 17 0v13M3 24h5" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function CreateAgent({ children = "Create an agent" }: { children?: string }) {
  return <Button asChild className="lv2-button"><Link to={signup}>{children}</Link></Button>;
}

export function LandingV2() {
  const [mode, setMode] = useState<"personal" | "business">("personal");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const dismissMenu = () => { setMenuOpen(false); menuTrigger.current?.focus(); };

  return <div className="landing-v2" onKeyDown={event => {
    if (event.key === "Escape" && menuOpen) dismissMenu();
  }}>
    <title>Agents | An agent for the things you do</title>
    <meta name="robots" content="noindex, follow" />
    <a className="lv2-skip" href="#landing-main">Skip to content</a>
    <header className="lv2-header lv2-container">
      <Link to="/landingv2" className="lv2-brand" aria-label="Agents home"><AgentMark /><span>Agents</span></Link>
      <nav className="lv2-desktop-nav" aria-label="Product navigation"><a href="#product">Product</a><a href="#personal">Personal</a><a href="#business">Business</a></nav>
      <div className="lv2-header-actions"><Link to="/login" className="lv2-signin">Sign in</Link><CreateAgent>Get started</CreateAgent><Button ref={menuTrigger} type="button" variant="ghost" size="icon" className="lv2-menu-trigger" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="lv2-mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}><HugeiconsIcon icon={menuOpen ? Cancel01Icon : Menu01Icon} size={22} aria-hidden="true" /></Button></div>
      <nav id="lv2-mobile-navigation" className="lv2-mobile-nav" aria-label="Mobile navigation" hidden={!menuOpen}>
        <a href="#product" onClick={() => setMenuOpen(false)}>Product</a><a href="#personal" onClick={() => setMenuOpen(false)}>Personal</a><a href="#business" onClick={() => setMenuOpen(false)}>Business</a><Link to="/login">Sign in</Link>
      </nav>
    </header>
    <main id="landing-main">
      <section className="lv2-hero" aria-labelledby="lv2-title">
        <div className="lv2-hero-copy lv2-container">
          <h1 id="lv2-title">An agent for the things you do.</h1>
          <p>Research a topic, compare documents or help a customer.</p>
          <CreateAgent />
        </div>
        <div className="lv2-coast-scene">
          <picture className="lv2-coast"><source type="image/webp" srcSet="/images/landing-v2/coast-small.webp 960w, /images/landing-v2/coast.webp 2048w" sizes="100vw" /><img src="/images/landing-v2/coast.webp" alt="Atlantic waves meeting a rocky coast beneath mountains in the evening light" width="2048" height="768" fetchPriority="high" /></picture>
          <div className="lv2-hero-preview">
            <div className="lv2-preview-switch" role="group" aria-label="Agent preview">
              <button type="button" aria-pressed={mode === "personal"} onClick={() => setMode("personal")}>Personal</button>
              <button type="button" aria-pressed={mode === "business"} onClick={() => setMode("business")}>Business</button>
            </div>
            <div className="lv2-preview-content" key={mode}>{mode === "personal" ? <PersonalPreview hero /> : <BusinessPreview hero />}</div>
          </div>
        </div>
      </section>
      <div className="lv2-container lv2-sections">
        <section id="personal" className="lv2-feature lv2-personal" aria-labelledby="lv2-personal-heading">
          <div className="lv2-feature-copy"><h2 id="lv2-personal-heading">For your own work.</h2><p>Work through your documents, research a question or turn your notes into a plan.</p></div>
          <PersonalPreview />
        </section>
        <section id="business" className="lv2-feature lv2-business" aria-labelledby="lv2-business-heading">
          <BusinessPreview />
          <div className="lv2-feature-copy"><h2 id="lv2-business-heading">For your business.</h2><p>Help customers, collect enquiries and bring your team into the conversation.</p></div>
        </section>
        <section id="product" className="lv2-foundation" aria-labelledby="lv2-foundation-heading">
          <h2 id="lv2-foundation-heading">You choose what it knows and does.</h2>
          <AgentSettingsPreview />
        </section>
        <section className="lv2-feature lv2-website" aria-labelledby="lv2-website-heading">
          <div className="lv2-feature-copy"><h2 id="lv2-website-heading">Use it where you need it.</h2><p>Keep it in your workspace, share it with your team, or connect it to your website.</p></div>
          <WebsitePreview />
        </section>
        <section className="lv2-closing" aria-labelledby="lv2-closing-heading"><h2 id="lv2-closing-heading">Make it yours.</h2><CreateAgent /><a className="lv2-workspace-link" href="/app/agents">Already have an agent?<HugeiconsIcon icon={ArrowRight01Icon} size={16} aria-hidden="true" /></a></section>
      </div>
    </main>
    <footer className="lv2-footer lv2-container">
      <a href="https://kasitek.co.za" className="lv2-footer-brand"><AgentMark /><span>Agents <small>by KasiTek</small></span></a>
      <nav aria-label="Footer navigation"><a href="#product">Product</a><a href="#personal">Personal</a><a href="#business">Business</a></nav>
      <div className="lv2-footer-legal"><a href="https://kasitek.co.za/privacy-policy">Privacy</a><a href="https://kasitek.co.za/terms">Terms</a><span>© {new Date().getFullYear()} KasiTek</span></div>
      <p className="lv2-preview-note">Product previews are illustrative.</p>
    </footer>
  </div>;
}
