import { Link, useNavigate } from "react-router";
import { useEffect } from "react";
import { ArrowRight, ArrowUpRight, MessageSquare, Megaphone, Bot } from "lucide-react";
import styles from "./landing.module.css";
import { getCoreSession } from "@/lib/core-auth";
import { publicSiteUrl } from "@/lib/public-site";

export const meta = () => [
  { name: "robots", content: "index, follow" },
  { title: "Growth | KasiTek" },
  { name: "description", content: "Manage customer conversations, campaigns, content and bookings in your Growth workspace." },
  { tagName: "link", rel: "canonical", href: "https://growth.kasitek.co.za/" },
  { property: "og:title", content: "Growth | KasiTek" },
  { property: "og:description", content: "Your customer conversations, campaigns, content and bookings in one workspace." },
  { property: "og:url", content: "https://growth.kasitek.co.za/" },
  { property: "og:type", content: "website" },
  { name: "twitter:card", content: "summary" },
];
export default function GrowthLandingPage() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    void getCoreSession().then((session) => { if (active && session?.user) navigate("/workspace", { replace: true }); }).catch(() => {});
    return () => { active = false; };
  }, [navigate]);
  return (
    <div className={styles.landing}>
      <header className={styles.nav}>
        <Link to="/" className={styles.brand} aria-label="KasiTek Growth home">kasitek<span>/ growth</span></Link>
        <nav aria-label="Public navigation">
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in<ArrowUpRight size={14} aria-hidden="true" /></Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="growth-heading">
          <p className={styles.kicker}>KasiTek Growth</p>
          <h1 id="growth-heading">Stay close to<br />your customers.</h1>
          <p className={styles.intro}>Manage customer conversations, campaigns, content and bookings in one workspace. Let your agents help with the everyday work.</p>
          <div className={styles.actions}>
            <Link to="/signup" className={styles.cta}>Get started<ArrowRight size={18} aria-hidden="true" /></Link>
          </div>
        </section>

        <section className={styles.possibilities} aria-labelledby="workspace-heading">
          <div className={styles.sectionHead}>
            <p className={styles.kicker}>Your workspace</p>
            <h2 id="workspace-heading">Keep your business moving.</h2>
          </div>
          <div className={styles.cards}>
            <article>
              <MessageSquare aria-hidden="true" />
              <h3>Talk to your customers</h3>
              <p>Manage conversations in your inbox and keep track of bookings.</p>
            </article>
            <article>
              <Megaphone aria-hidden="true" />
              <h3>Plan your next campaign</h3>
              <p>Create content, organise campaigns and review your work before it goes out.</p>
            </article>
            <article>
              <Bot aria-hidden="true" />
              <h3>Work with your agents</h3>
              <p>Ask your assistant for help, give it context and review the results in your workspace.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>© {new Date().getFullYear()} KasiTek</span>
        <nav aria-label="Public site links">
          <a href={publicSiteUrl}>KasiTek Labs<ArrowUpRight size={14} aria-hidden="true" /></a>
          <a href={`${publicSiteUrl}/about`}>About</a>
          <Link to="/pricing">Pricing</Link>
          <a href={`${publicSiteUrl}/demo`}>Book a demo</a>
          <a href={`${publicSiteUrl}/privacy-policy`}>Privacy</a>
          <a href={`${publicSiteUrl}/terms`}>Terms</a>
        </nav>
      </footer>
    </div>
  );
}
