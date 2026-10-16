import { redirect } from "next/navigation";

export default function AccountPage() {
  redirect("/api/auth/account");
}
