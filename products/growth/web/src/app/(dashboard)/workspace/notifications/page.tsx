import { redirect } from "react-router";

export function meta() { return [{ title: "Notifications | KasiTek" }]; }

export function clientLoader() {
  throw redirect("/workspace/settings?section=notifications");
}

export default function WorkspaceNotificationsPage() { return null; }
