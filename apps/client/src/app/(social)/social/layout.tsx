import { auth } from "@/auth";
import { SocialLayoutShell } from "@/components/social/layout-shell";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "next/navigation";

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <>
      <ThemeScope mode="stored" />
      <SocialLayoutShell user={session.user}>{children}</SocialLayoutShell>
    </>
  );
}
