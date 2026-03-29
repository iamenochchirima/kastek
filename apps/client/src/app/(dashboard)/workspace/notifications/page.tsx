import PushNotificationSettings from "@/components/dashboard/notifications/push-notification-settings";

export const metadata = {
  title: "Notifications | KasiTek",
};

export default function WorkspaceNotificationsPage() {
  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1000px]">
        <PushNotificationSettings />
      </div>
    </div>
  );
}
