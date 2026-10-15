import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Palette,
  Users,
} from "lucide-react";
import Link from "@/lib/link";
import "@/styles/marketing.css";
export default function AgencyLandingScreen() {
  return (
    <div className="marketing">
      <nav className="marketing-nav">
        <Link href="/" className="marketing-brand">
          kasitek<span>/ agency</span>
        </Link>
        <div>
          <a href="#possibilities">Explore</a>
          <Link href="/login?audience=partner">
            Sign in
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </nav>
      <main>
        <section className="marketing-hero">
          <p className="marketing-kicker">Your business. Your brand.</p>
          <h1>
            Make room for
            <br />
            your next <em>chapter.</em>
          </h1>
          <p className="marketing-intro">
            Create a white-label workspace for your agency. Bring your brand,
            your team and your clients together.
          </p>
          <div className="marketing-actions">
            <Link href="/register" className="marketing-cta">
              Create your business
              <ArrowRight size={18} />
            </Link>
            <a href="#possibilities" className="marketing-secondary">
              See how it works
            </a>
          </div>
          <p className="marketing-footnote">
            Start with a workspace. Set up your branding and invite the people
            you work with.
          </p>
        </section>
        <section id="possibilities" className="marketing-possibilities">
          <div className="marketing-section-head">
            <p className="marketing-kicker">A workspace that belongs to you</p>
            <h2>
              From your first business
              <br />
              to the team behind it.
            </h2>
          </div>
          <div className="marketing-cards">
            <article>
              <Building2 />
              <h3>Your businesses</h3>
              <p>
                Create and manage separate businesses from one partner account.
                Keep each business's workspace and data separate.
              </p>
            </article>
            <article>
              <Palette />
              <h3>Your identity</h3>
              <p>
                Choose your business name, logo and colours. Give clients a
                portal that reflects your brand.
              </p>
            </article>
            <article>
              <Users />
              <h3>Your people</h3>
              <p>
                Invite teammates with the right access. Add clients and give
                them their own workspace.
              </p>
            </article>
          </div>
        </section>
        <section
          className="marketing-product"
          aria-labelledby="product-preview-title"
        >
          <p className="marketing-kicker">Inside your workspace</p>
          <h2 id="product-preview-title">
            Set it up.
            <br />
            Make it yours.
          </h2>
          <p className="marketing-product-intro">
            Create your business, shape its branding and manage your team and
            clients. You can return to each business whenever you need.
          </p>
          <figure className="marketing-preview">
            <img
              src="/images/product/agency-preview.png"
              width={1280}
              height={800}
              loading="lazy"
              decoding="async"
              alt="Agency business settings showing the business setup checklist and branding controls."
            />
            <figcaption>
              Local development screenshot of Agency business setup and
              branding.
            </figcaption>
          </figure>
        </section>
        <section className="marketing-closing">
          <h2>
            Your next chapter
            <br />
            starts here.
          </h2>
          <Link href="/register" className="marketing-cta">
            Create your account
            <ArrowRight size={18} />
          </Link>
        </section>
      </main>
      <footer>
        <span>© {new Date().getFullYear()} KasiTek</span>
        <Link href="/login?audience=partner">
          Open your workspace
          <ArrowUpRight size={14} />
        </Link>
      </footer>
    </div>
  );
}
