import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, BookOpen, MessageSquare, SlidersHorizontal } from "lucide-react";
import { api, type Session } from "./api";
import "@/styles/marketing.css";

export function Landing() {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let active = true;
    void api<Session>("/api/session").then(() => { if (active) setSignedIn(true); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const entry = signedIn ? "/app/agents" : "/signup";
  return <div className="marketing">
    <nav className="marketing-nav" aria-label="Public navigation">
      <Link to="/" className="marketing-brand">kasitek<span>/ agents</span></Link>
      <div className="flex items-center gap-4"><Link to="/pricing">Pricing</Link><Link to={signedIn ? "/app/agents" : "/login"}>{signedIn ? "Open workspace" : "Sign in"}<ArrowUpRight size={14} aria-hidden="true" /></Link></div>
    </nav>
    <main>
      <section className="marketing-hero">
        <p className="marketing-kicker">KasiTek Agents</p>
        <h1>Make room<br />for better work.</h1>
        <p className="marketing-intro">Agents for research, support and everyday work. Give them knowledge and tools, then start a conversation.</p>
        <div className="marketing-actions"><Link to={entry} className="marketing-cta">{signedIn ? "Open workspace" : "Get started"}<ArrowRight size={18} aria-hidden="true" /></Link></div>
      </section>
      <section id="possibilities" className="marketing-possibilities" aria-labelledby="agent-flow-title">
        <div className="marketing-section-head"><p className="marketing-kicker">Your agents</p><h2 id="agent-flow-title">Set up. Start a conversation.</h2></div>
        <div className="marketing-cards">
          <article><SlidersHorizontal aria-hidden="true" /><h3>Define the work</h3><p>Set instructions and choose the tools your agent can use.</p></article>
          <article><BookOpen aria-hidden="true" /><h3>Add knowledge</h3><p>Connect approved sources for answers with references.</p></article>
          <article><MessageSquare aria-hidden="true" /><h3>Talk to your agent</h3><p>Ask a question, follow the work and review the result.</p></article>
        </div>
      </section>
    </main>
    <footer><span>© {new Date().getFullYear()} KasiTek</span><div className="flex items-center gap-4"><Link to="/pricing">Pricing</Link><Link to={signedIn ? "/app/agents" : "/login"}>Open your workspace<ArrowUpRight size={14} aria-hidden="true" /></Link></div></footer>
  </div>;
}
