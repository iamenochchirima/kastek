export const metadata = {
  title: "Data Deletion | KasiAI",
};

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-bg px-6 py-20 text-text md:px-10">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-[0.2em] text-accent">Data Deletion</p>
          <h1 className="text-4xl font-black uppercase tracking-[-0.04em]">Data Deletion Request</h1>
          <p className="text-text-muted">Last updated: March 2, 2026</p>
        </header>

        <section className="space-y-4 text-base leading-8 text-text-muted">
          <p>
            If you would like KasiAI to delete personal or business data associated with your
            account or use of our services, you may submit a request by email.
          </p>
          <p>
            Please include your full name, business name, email address, phone number, and a clear
            description of the data or account you want deleted.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">How To Request Deletion</h2>
          <p className="text-base leading-8 text-text-muted">
            Send your request to{" "}
            <a className="text-accent hover:underline" href="mailto:info@kasiai.site?subject=Data%20Deletion%20Request">
              info@kasiai.site
            </a>
            {" "}with the subject line `Data Deletion Request`.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Verification</h2>
          <p className="text-base leading-8 text-text-muted">
            KasiAI may request additional information to verify identity and confirm authority over
            the account or data before processing deletion.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Important Note</h2>
          <p className="text-base leading-8 text-text-muted">
            Some information may need to be retained where required for legal, tax, security, fraud
            prevention, contractual, or operational reasons.
          </p>
        </section>
      </div>
    </main>
  );
}
