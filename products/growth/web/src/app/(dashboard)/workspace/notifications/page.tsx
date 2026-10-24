import { redirect } from "react-router";

export function meta() { return [{ title: "Notifications | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export function clientLoader() {
  throw redirect("/workspace/settings?section=notifications");
}

export default function WorkspaceNotificationsPage() { return null; }
