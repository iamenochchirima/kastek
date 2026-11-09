import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { AgentSettingsPreview, BusinessPreview, ChannelIcons, KnowledgePreview, WebsitePreview } from "./landing-v2-previews";
import "./landing-v2.css";

const signup = "/signup?returnTo=%2Fapp%2Fagents";
const faqs = [
  { question: "What can a business agent do?", answer: "Answer questions using approved business knowledge, collect enquiries and book appointments through connected services. You choose its responsibilities and permissions." },
  { question: "Can my team take over?", answer: "Yes. Your team can join a customer conversation in Inbox, reply directly and return it to the agent." },
  { question: "Where can customers reach it?", answer: "Connect your website, WhatsApp, Messenger, Instagram or Telegram. Each channel requires its own authorized connection and activation." },
  { question: "Can I deploy a personal agent?", answer: "Personal agents are part of this design preview. The current standalone product supports customer-service agents; personal-agent deployment is not available yet.", id: "personal-availability" },
];

function CreateAgent({ children = "Create an agent", dark = false }: { children?: string; dark?: boolean }) {
  return <Button asChild className={`lv2-button${dark ? " is-dark" : ""}`}><Link to={signup}>{children}<HugeiconsIcon icon={ArrowRight01Icon} size={17} aria-hidden="true" /></Link></Button>;
}

function Glow({ paused }: { paused: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let visible = false;
    const update = () => setRunning(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(node);
    document.addEventListener("visibilitychange", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); };
  }, []);
  return <div ref={element} className="lv2-glow" data-running={running && !paused} aria-hidden="true"><span /><span /><span /></div>;
}

export function LandingV2() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [motionPaused, setMotionPaused] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const dismissMenu = () => { setMenuOpen(false); menuTrigger.current?.focus(); };

  return <div className="landing-v2" onKeyDown={event => { if (event.key === "Escape" && menuOpen) dismissMenu(); }}>
    <title>Agents | Your customer service agent</title>
    <meta name="description" content="Customer service agents for your business. Answer questions, handle enquiries and manage bookings with your knowledge and connected tools." />
    <meta name="robots" content="noindex, follow" />
    <a className="lv2-skip" href="#landing-main">Skip to content</a>
    <main id="landing-main">
      <section className="lv2-hero" aria-labelledby="lv2-title">
        <Glow paused={motionPaused} />
        <header className="lv2-header">
          <Link to="/landingv2" className="lv2-brand" aria-label="Agents home">Agents <small>by KasiTek</small></Link>
          <nav className="lv2-desktop-nav" aria-label="Product navigation"><a href="#product">Product</a><a href="#personal">Personal</a><Link to="/pricing">Pricing</Link></nav>
          <div className="lv2-header-actions"><Link to="/login" className="lv2-signin">Sign in</Link><CreateAgent dark>Get started</CreateAgent><Button ref={menuTrigger} type="button" variant="ghost" size="icon" className="lv2-menu-trigger" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-expanded={menuOpen} aria-controls="lv2-mobile-navigation" onClick={() => setMenuOpen(!menuOpen)}><HugeiconsIcon icon={menuOpen ? Cancel01Icon : Menu01Icon} size={20} aria-hidden="true" /></Button></div>
          <nav id="lv2-mobile-navigation" className="lv2-mobile-nav" aria-label="Mobile navigation" hidden={!menuOpen}><a href="#product" onClick={() => setMenuOpen(false)}>Product</a><a href="#personal" onClick={() => setMenuOpen(false)}>Personal</a><Link to="/login">Sign in</Link></nav>
        </header>
        <div className="lv2-hero-copy lv2-container">
          <p className="lv2-hero-kicker">Your customer service agent.</p>
          <h1 id="lv2-title">Agents</h1>
          <p className="lv2-hero-description">Answers questions, handles enquiries and manages bookings.</p>
          <CreateAgent />
        </div>
        <figure className="lv2-laptop"><picture><source type="image/webp" srcSet="/images/landing-v2/business-laptop-small.webp 800w, /images/landing-v2/business-laptop.webp 1600w" sizes="(max-width: 600px) 100vw, (max-width: 1200px) 90vw, 1080px" /><img src="/images/landing-v2/business-laptop.webp" alt="A laptop showing Riverside Studio's customer service agent arranging Maya's consultation and confirming the booking." width="1600" height="910" fetchPriority="high" /></picture></figure>
        <button type="button" className="lv2-motion" aria-pressed={motionPaused} onClick={() => setMotionPaused(!motionPaused)}>{motionPaused ? "Resume motion" : "Pause motion"}</button>
        <div className="lv2-curve" aria-hidden="true" />
      </section>
      <div className="lv2-container lv2-sections">
        <section id="product" className="lv2-feature lv2-knowledge" aria-labelledby="lv2-knowledge-heading"><div className="lv2-feature-copy"><h2 id="lv2-knowledge-heading">Start with what<br className="lv2-desktop-break" /> your business knows.</h2><p>Import your website and add your documents.</p></div><KnowledgePreview /></section>
        <section className="lv2-feature lv2-handoff" aria-labelledby="lv2-handoff-heading"><BusinessPreview /><div className="lv2-feature-copy"><h2 id="lv2-handoff-heading">Your team<br className="lv2-desktop-break" /> can take over.</h2><p>Join a conversation, reply and return it to your agent.</p></div></section>
        <section className="lv2-foundation" aria-labelledby="lv2-foundation-heading"><h2 id="lv2-foundation-heading">You decide what it can access.</h2><p>Choose its knowledge, tools and permissions.</p><AgentSettingsPreview /></section>
        <section className="lv2-feature lv2-website" aria-labelledby="lv2-website-heading"><div className="lv2-feature-copy"><h2 id="lv2-website-heading">Where your customers<br className="lv2-desktop-break" /> already are.</h2><p>Answer enquiries on your website, messaging channels and social media.</p><ChannelIcons /></div><WebsitePreview /></section>
      </div>
      <section id="personal" className="lv2-personal" aria-labelledby="lv2-personal-heading"><div className="lv2-container lv2-personal-inner"><div className="lv2-feature-copy"><h2 id="lv2-personal-heading">One personal agent.<br />Wherever you work.</h2><p>Deploy your agent with your context and tools.</p><a className="lv2-personal-link" href="#personal-availability" onClick={() => { const detail = document.getElementById("personal-availability"); if (detail instanceof HTMLDetailsElement) detail.open = true; }}>Explore personal agents<HugeiconsIcon icon={ArrowRight01Icon} size={17} aria-hidden="true" /></a></div><figure className="lv2-personal-devices"><picture><source type="image/webp" srcSet="/images/landing-v2/personal-devices-small.webp 800w, /images/landing-v2/personal-devices.webp 1600w" sizes="(max-width: 800px) 100vw, (max-width: 1200px) 70vw, 850px" /><img src="/images/landing-v2/personal-devices.webp" alt="Personal-agent concept: Ari prepares the same client brief on a laptop, displays it on a tablet and shares the completed brief in a phone conversation." width="1600" height="910" loading="lazy" /></picture><figcaption>Personal agent preview</figcaption></figure></div></section>
      <section className="lv2-faq lv2-container" aria-label="Frequently asked questions">{faqs.map(faq => <details key={faq.question} id={faq.id}><summary>{faq.question}<span aria-hidden="true">+</span></summary><p>{faq.answer}</p></details>)}</section>
      <section className="lv2-closing" aria-labelledby="lv2-closing-heading"><Glow paused={motionPaused} /><h2 id="lv2-closing-heading">Put your agent to work.</h2><CreateAgent /></section>
    </main>
    <footer className="lv2-footer lv2-container"><Link to="/landingv2" className="lv2-footer-brand">Agents <small>by KasiTek</small></Link><nav aria-label="Footer navigation"><a href="#product">Product</a><a href="#personal">Personal</a><Link to="/pricing">Pricing</Link><Link to="/login">Sign in</Link></nav><div className="lv2-footer-legal"><a href="https://kasitek.co.za/privacy-policy">Privacy</a><a href="https://kasitek.co.za/terms">Terms</a></div><p className="lv2-preview-note">Product illustrations contain example information.</p></footer>
  </div>;
}
