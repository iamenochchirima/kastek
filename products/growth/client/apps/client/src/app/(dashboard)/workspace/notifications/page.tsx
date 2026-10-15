import { redirect } from "next/navigation";

export const metadata = {
  title: "Notifications | KasiTek",
};

export default function WorkspaceNotificationsPage() {
  redirect("/workspace/settings?section=notifications");
}
