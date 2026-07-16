import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Settings | KasiTek",
};

export default async function ReachSettingsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="text-muted-foreground">
            Manage campaign and inbox preferences.
          </p>
        </div>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Inbox Alerts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Control desktop popups and sound alerts for new inbound WhatsApp messages while the app
            is open in your browser.
          </p>
          <div className="mt-4">
            <InboxAlertControls title="KasiTek Inbox Alerts" showStatus compact={false} />
          </div>
        </section>
      </div>
    </div>
  );
}
