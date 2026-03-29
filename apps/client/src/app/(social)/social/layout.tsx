import { LayoutShell } from "@/components/dashboard/layout-shell";
import ThemeScope from "@/components/theme-scope";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  return (
    <>
      <ThemeScope mode="stored" />
      <LayoutShell user={session.user}>{children}</LayoutShell>
    </>
  );
}
