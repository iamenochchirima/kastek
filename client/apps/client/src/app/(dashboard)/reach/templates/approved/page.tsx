import { redirect } from "next/navigation";

export default function ReachTemplatesApprovedPage() {
  redirect("/reach/templates?status=APPROVED");
}
