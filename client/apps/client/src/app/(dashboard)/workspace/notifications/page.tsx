import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";
import PushNotificationSettings from "@/components/dashboard/notifications/push-notification-settings";

export const metadata = {
  title: "Notifications | KasiTek",
};

export default function WorkspaceNotificationsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1000px] space-y-6">
        <PushNotificationSettings />
        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Inbox alerts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Control desktop popups and sounds for inbound workspace messages while the app is open.
          </p>
          <div className="mt-4">
            <InboxAlertControls title="KasiTek Inbox Alerts" showStatus compact={false} />
          </div>
        </section>
      </div>
    </div>
  );
}
