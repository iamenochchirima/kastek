import { redirect } from "next/navigation";

export default function ReachTemplatesPendingPage() {
  redirect("/reach/templates?status=PENDING");
}
