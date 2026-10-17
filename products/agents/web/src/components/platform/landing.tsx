import { ArrowRight, Globe2, MessageSquare, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import Link from "@/lib/link";
import "@/styles/marketing.css";
export function Landing() {
  return (
    <div className="marketing">
      <nav className="marketing-nav">
        <Link href="/" className="marketing-brand">kasitek<span>/ agents</span></Link>
        <div><Link href="/login">Sign in <ArrowUpRight size={14} /></Link></div>
      </nav>
      <main>
        <section className="marketing-hero">
          <p className="marketing-kicker">KasiTek Agents</p>
          <h1>Make support<br />simpler.</h1>
          <p className="marketing-intro">Set up an assistant for your customers, test it privately, and publish it when it is ready.</p>
          <div className="marketing-actions">
            <Link href="/signup" className="marketing-cta">Get started <ArrowRight size={18} /></Link>
          </div>
        </section>
        <section id="possibilities" className="marketing-possibilities" aria-labelledby="agent-flow-title">
          <div className="marketing-section-head">
            <p className="marketing-kicker">One simple flow</p>
            <h2 id="agent-flow-title">From setup to your website.</h2>
          </div>
          <div className="marketing-cards">
            <article><SlidersHorizontal /><h3>Configure</h3><p>Set the assistant’s instructions and choose what it can use.</p></article>
            <article><MessageSquare /><h3>Test</h3><p>Try a private conversation before customers see it.</p></article>
            <article><Globe2 /><h3>Publish</h3><p>Put the tested version on your website when you are ready.</p></article>
          </div>
        </section>
      </main>
      <footer><span>© {new Date().getFullYear()} KasiTek</span><Link href="/login">Open your workspace <ArrowUpRight size={14} /></Link></footer>
    </div>
  );
}
export function SignIn({ signup = false }: { signup?: boolean }) {
 const localLogout = new URLSearchParams(window.location.search).get("logout") === "local";
 return <div className="marketing marketing-auth"><Link href="/" className="marketing-brand">kasitek<span>/ agents</span></Link><section><p className="marketing-kicker">One KasiTek account</p><h1>{signup ? "Make room for your ideas." : "Welcome back."}</h1><p>Use your email, Google account or passkey through shared KasiTek sign-in.</p>{localLogout && <p role="status">You are signed out of Agents. Shared sign-out could not finish because the sign-in service was unavailable.</p>}<a className="marketing-cta" href={`/api/auth/${signup ? "signup" : "login"}?returnTo=${encodeURIComponent("/app")}`}>{signup ? "Create account" : "Continue to sign in"}<ArrowRight size={18} /></a><Link href={signup ? "/login" : "/signup"}>{signup ? "Already have an account? Sign in" : "New here? Create an account"}</Link></section></div>;
}
