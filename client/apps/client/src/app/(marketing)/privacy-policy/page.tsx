export const metadata = {
  title: "Privacy Policy | KasiTek",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-20 text-foreground md:px-10">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-[0.2em] text-primary">Privacy Policy</p>
          <h1 className="text-4xl font-black uppercase tracking-[-0.04em] text-foreground">Privacy Policy</h1>
          <p className="text-muted-foreground">Last updated: March 2, 2026</p>
        </header>

        <section className="space-y-4 text-base leading-8 text-muted-foreground">
          <p>
            KasiTek collects and processes information that is necessary to provide websites, AI
            agents, messaging systems, automation systems, customer support, social management,
            and related digital services.
          </p>
          <p>
            This may include contact details, account information, business information, technical
            usage data, and information submitted through forms, chats, or onboarding flows.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">What We Collect</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>Name, email address, phone number, business name, and service enquiry details.</p>
            <p>Account and authentication information for platform access.</p>
            <p>Usage, device, browser, and interaction data needed for analytics, security, and service improvement.</p>
            <p>Business content and operational data provided for website, agent, campaign, or automation setup.</p>
            <p>Information received from connected communication and social platforms where a client chooses to connect those services to KasiTek.</p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Connected Platform Data</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>
              KasiTek allows clients to connect business communication and social channels such as
              WhatsApp Business, Facebook Pages, Instagram Business, and similar supported services.
              When a client connects these channels, we process the information needed to provide
              the features they enable.
            </p>
            <p>
              Depending on the connected channel and permissions granted, this may include account
              and profile information, page or channel identifiers, message and conversation
              content, comments and replies, posts or scheduled content, template and campaign
              information, delivery or engagement status, and related service logs.
            </p>
            <p>
              We use this information to provide the service requested by the client, including
              inbox management, message sending and receiving, social publishing, automation,
              reporting, support, security, troubleshooting, and compliance with applicable
              platform requirements.
            </p>
            <p>
              KasiTek does not sell customer message content, connected social account data, or
              platform data received through connected third-party services.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">How We Use Information</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>To deliver, maintain, improve, and support KasiTek services.</p>
            <p>To communicate with clients about projects, billing, updates, and support.</p>
            <p>To operate account access, onboarding, analytics, and security controls.</p>
            <p>To operate connected inboxes, social publishing, messaging, automation, reporting, and customer support workflows on behalf of clients.</p>
            <p>To comply with legal obligations and enforce our service terms.</p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Sharing Of Information</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>
              KasiTek may share information with infrastructure, hosting, analytics, messaging,
              payment, and authentication providers where necessary to operate the service.
            </p>
            <p>
              Information is not sold to third parties. Data may also be disclosed where required
              by law or to protect the security and integrity of the platform.
            </p>
            <p>
              Where a client connects third-party platforms such as Meta, WhatsApp, Facebook, or
              Instagram, data may be transmitted to or received from those platforms to provide the
              connected service. Use of those platforms is also subject to their own terms and
              policies.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Data Retention</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek retains personal and business data only for as long as it is reasonably needed
            to deliver services, maintain records, meet legal obligations, resolve disputes, and
            support legitimate business operations.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Your Rights</h2>
          <p className="text-base leading-8 text-muted-foreground">
            You may request access to, correction of, or deletion of personal data held by KasiTek,
            subject to legal, operational, and security requirements. Data deletion requests can be
            submitted through our dedicated data deletion page.
          </p>
          <p className="text-base leading-8 text-muted-foreground">
            Clients can also disconnect connected Meta, WhatsApp, Facebook, or Instagram accounts
            from their workspace where supported. Disconnection may stop future syncing while some
            historical records may be retained where required for security, legal, audit, billing,
            or operational reasons.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Contact</h2>
          <p className="text-base leading-8 text-muted-foreground">
            For privacy-related questions, contact KasiTek at{" "}
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
