import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";
import PushNotificationSettings from "@/components/dashboard/notifications/push-notification-settings";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";

export const metadata = {
  title: "Notifications | KasiTek",
};

export default function WorkspaceNotificationsPage() {
  return (
    <div className="min-h-screen px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>Notifications</PageHeaderTitle></PageHeaderContent></PageHeader>
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
