import ProfileForm from "@/components/dashboard/profile/profile-form";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Profile | KasiTek",
};

export default async function WorkspaceProfilePage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const profile = await fetchRustJson<{
    user: {
      name: string | null;
      email: string | null;
      emailVerified: string | null;
      phone: string | null;
      image: string | null;
    };
    hasPassword: boolean;
  }>("/api/profile").catch(() => null);

  if (!profile?.user) redirect("/login");

  return (
    <div className="min-h-[100dvh] px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader><PageHeaderContent><PageHeaderTitle>Profile</PageHeaderTitle></PageHeaderContent></PageHeader>

        <MotionReveal delay={0.08}>
          <ProfileForm
            user={{
            name: profile.user.name,
            email: profile.user.email,
            emailVerified: !!profile.user.emailVerified,
            phone: profile.user.phone,
            image: profile.user.image,
            hasPassword: profile.hasPassword,
            }}
          />
        </MotionReveal>
      </div>
    </div>
  );
}
