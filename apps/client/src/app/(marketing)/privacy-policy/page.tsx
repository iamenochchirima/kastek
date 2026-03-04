export const metadata = {
  title: "Privacy Policy | KasiAI",
};

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-bg px-6 py-20 text-text md:px-10">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-[0.2em] text-accent">Privacy Policy</p>
          <h1 className="text-4xl font-black uppercase tracking-[-0.04em]">Privacy Policy</h1>
          <p className="text-text-muted">Last updated: March 2, 2026</p>
        </header>

        <section className="space-y-4 text-base leading-8 text-text-muted">
          <p>
            KasiAI collects and processes information that is necessary to provide websites, AI
            agents, automation systems, customer support, and related digital services.
          </p>
          <p>
            This may include contact details, account information, business information, technical
            usage data, and information submitted through forms, chats, or onboarding flows.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">What We Collect</h2>
          <div className="space-y-3 text-base leading-8 text-text-muted">
            <p>Name, email address, phone number, business name, and service enquiry details.</p>
            <p>Account and authentication information for platform access.</p>
            <p>Usage, device, browser, and interaction data needed for analytics, security, and service improvement.</p>
            <p>Business content and operational data provided for website, agent, campaign, or automation setup.</p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">How We Use Information</h2>
          <div className="space-y-3 text-base leading-8 text-text-muted">
            <p>To deliver, maintain, improve, and support KasiAI services.</p>
            <p>To communicate with clients about projects, billing, updates, and support.</p>
            <p>To operate account access, onboarding, analytics, and security controls.</p>
            <p>To comply with legal obligations and enforce our service terms.</p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Sharing Of Information</h2>
          <div className="space-y-3 text-base leading-8 text-text-muted">
            <p>
              KasiAI may share information with infrastructure, hosting, analytics, messaging,
              payment, and authentication providers where necessary to operate the service.
            </p>
            <p>
              Information is not sold to third parties. Data may also be disclosed where required
              by law or to protect the security and integrity of the platform.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Data Retention</h2>
          <p className="text-base leading-8 text-text-muted">
            KasiAI retains personal and business data only for as long as it is reasonably needed
            to deliver services, maintain records, meet legal obligations, resolve disputes, and
            support legitimate business operations.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Your Rights</h2>
          <p className="text-base leading-8 text-text-muted">
            You may request access to, correction of, or deletion of personal data held by KasiAI,
            subject to legal, operational, and security requirements. Data deletion requests can be
            submitted through our dedicated data deletion page.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Contact</h2>
          <p className="text-base leading-8 text-text-muted">
            For privacy-related questions, contact KasiAI at{" "}
            <a className="text-accent hover:underline" href="mailto:info@kasiai.site">
              info@kasiai.site
            </a>
            .
          </p>
        </section>
      </div>
    </main>
  );
}
