import { redirect } from "next/navigation";

export default function ReachTemplatesCreatePage() {
  redirect("/reach/templates?create=1");
}
