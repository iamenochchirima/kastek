import { redirect } from "next/navigation";

// Organisation members and workspace controls currently share the team screen.
export default function WorkspaceSettingsPage() {
  redirect("/workspace/team");
}
