export const metadata = {
  title: "Terms | KasiTek",
};

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-20 text-foreground md:px-10">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-[0.2em] text-primary">Terms</p>
          <h1 className="text-4xl font-black uppercase tracking-[-0.04em] text-foreground">Terms of Service</h1>
          <p className="text-muted-foreground">Last updated: March 2, 2026</p>
        </header>

        <section className="space-y-4 text-base leading-8 text-muted-foreground">
          <p>
            These terms govern access to and use of KasiTek websites, software, AI agents,
            messaging systems, automation services, and related deliverables.
          </p>
          <p>
            By using KasiTek services, you agree to these terms and any applicable project-specific
            agreements, quotations, or service schedules.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Services</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek provides digital services including websites, AI agents, campaigns, outreach
            systems, messaging systems, social management tools, automation workflows, and related
            support. Exact scope, pricing, timelines, and deliverables are defined in the relevant
            quotation, agreement, or project terms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Client Responsibilities</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>Clients must provide accurate information, required approvals, and timely access to systems and accounts.</p>
            <p>Clients remain responsible for third-party platform accounts, policy compliance, and content they provide.</p>
            <p>Clients must ensure they have the right to use any data, assets, or materials supplied to KasiTek.</p>
            <p>Clients are responsible for the legality, accuracy, consent status, and compliance of contact lists, message recipients, campaign audiences, templates, posts, comments, media, and other content submitted to or managed through KasiTek.</p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Meta And Third-Party Platforms</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>
              KasiTek may allow clients to connect third-party platforms such as WhatsApp Business,
              Facebook Pages, Instagram Business, and other communication or social channels. These
              integrations depend on the relevant platform APIs, permissions, review decisions,
              account status, rate limits, policies, and availability.
            </p>
            <p>
              Clients are responsible for complying with all applicable third-party platform terms,
              including Meta and WhatsApp policies, messaging rules, commerce rules, template
              requirements, consent and opt-in requirements, campaign restrictions, and content
              standards.
            </p>
            <p>
              KasiTek may suspend, limit, or remove access to messaging, publishing, automation, or
              campaign features where needed to protect platform integrity, comply with third-party
              requirements, respond to abuse, or prevent policy violations.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Messaging And Social Content</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>
              Clients control the content they send, publish, schedule, automate, or approve through
              KasiTek, including WhatsApp messages, Facebook Page content, Instagram content,
              comments, replies, templates, campaigns, and media.
            </p>
            <p>
              Clients must only message people where they have a valid basis to do so and must honor
              opt-outs, unsubscribe requests, customer preferences, and applicable privacy and
              electronic communications laws.
            </p>
            <p>
              AI-assisted features may draft, classify, route, summarize, or recommend responses,
              but clients remain responsible for reviewing outputs where appropriate and for the
              final use of content in their business.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Fees And Payments</h2>
          <p className="text-base leading-8 text-muted-foreground">
            Fees are due according to the applicable quotation or agreement. Third-party platform
            costs, messaging charges, hosting, or API fees may be billed separately unless
            explicitly stated otherwise in writing.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Intellectual Property</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek retains ownership of its pre-existing tools, systems, methods, templates, and
            platform components. Client-owned content, branding, and proprietary business materials
            remain the property of the client unless otherwise agreed.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">No Warranty</h2>
          <p className="text-base leading-8 text-muted-foreground">
            Services are provided on a reasonable-efforts basis. KasiTek does not guarantee specific
            business outcomes, uninterrupted third-party platform availability, or error-free
            operation at all times.
          </p>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek does not control third-party platform decisions, including account restrictions,
            app review outcomes, template approvals, message delivery, reach, ranking, rate limits,
            or policy enforcement by Meta, WhatsApp, Facebook, Instagram, or other platforms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Limitation Of Liability</h2>
          <p className="text-base leading-8 text-muted-foreground">
            To the maximum extent permitted by law, KasiTek is not liable for indirect, incidental,
            special, consequential, or lost-profit damages arising from use of the service or from
            third-party platforms and integrations.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Termination</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek may suspend or terminate service access for non-payment, policy violations,
            abuse, security concerns, or material breach of agreement. Clients may discontinue
            services according to the applicable notice or contract terms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Contact</h2>
          <p className="text-base leading-8 text-muted-foreground">
            For questions about these terms, contact{" "}
            <a className="text-primary hover:underline" href="mailto:info@kasitek.co.za">
              info@kasitek.co.za
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
