export const metadata = {
  title: "Data Deletion | KasiTek",
};

export default function DataDeletionPage() {
  return (
    <main className="min-h-screen bg-background px-6 py-20 text-foreground md:px-10">
      <div className="mx-auto max-w-4xl space-y-10">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-[0.2em] text-primary">Data Deletion</p>
          <h1 className="text-4xl font-black uppercase tracking-[-0.04em] text-foreground">Data Deletion Request</h1>
          <p className="text-muted-foreground">Last updated: March 2, 2026</p>
        </header>

        <section className="space-y-4 text-base leading-8 text-muted-foreground">
          <p>
            If you would like KasiTek to delete personal or business data associated with your
            account or use of our services, you may submit a request by email.
          </p>
          <p>
            Please include your full name, business name, email address, phone number, and a clear
            description of the data or account you want deleted.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Connected Meta Accounts</h2>
          <div className="space-y-3 text-base leading-8 text-muted-foreground">
            <p>
              If your workspace connects WhatsApp Business, Facebook Pages, Instagram Business, or
              other Meta business assets, you can request deletion of data KasiTek stores from those
              connections. This may include connected account records, message and conversation
              history, templates, comments, posts, media metadata, webhook events, campaign records,
              analytics, and related operational logs.
            </p>
            <p>
              You may also disconnect KasiTek from your Meta business assets through your workspace
              settings where available, or by removing the app connection in Meta Business settings.
              Disconnecting stops future access or syncing where technically supported.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">How To Request Deletion</h2>
          <p className="text-base leading-8 text-muted-foreground">
            Send your request to{" "}
            <a className="text-primary hover:underline" href="mailto:info@kasitek.co.za?subject=Data%20Deletion%20Request">
              info@kasitek.co.za
            </a>
            {" "}with the subject line `Data Deletion Request`.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Verification</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek may request additional information to verify identity and confirm authority over
            the account or data before processing deletion.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Processing Time</h2>
          <p className="text-base leading-8 text-muted-foreground">
            KasiTek will review deletion requests and respond within a reasonable period. Where a
            request relates to a business workspace, we may need confirmation from an authorized
            owner or administrator before deleting shared business data.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold uppercase">Important Note</h2>
          <p className="text-base leading-8 text-muted-foreground">
            Some information may need to be retained where required for legal, tax, security, fraud
            prevention, contractual, or operational reasons.
          </p>
          <p className="text-base leading-8 text-muted-foreground">
            Deleting data from KasiTek does not automatically delete data held by Meta, WhatsApp,
            Facebook, Instagram, or other third-party platforms. You may need to manage those
            records directly with the relevant platform.
          </p>
        </section>
      </div>
    </main>
  );
}
