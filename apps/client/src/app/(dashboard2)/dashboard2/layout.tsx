import { auth } from "@/auth";
import { LayoutShell } from "@/components/dashboard2/layout-shell";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "next/navigation";

export default async function Dashboard2Layout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <>
      <ThemeScope mode="stored" />
      <LayoutShell user={session.user}>{children}</LayoutShell>
    </>
  );
}
