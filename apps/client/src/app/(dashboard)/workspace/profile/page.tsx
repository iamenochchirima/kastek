import ProfileForm from "@/components/dashboard/profile/profile-form";
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
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Profile</h1>
          <p className="mt-2 text-muted-foreground">
            Manage your personal account details separately from workspace integrations and channels.
          </p>
        </div>

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
      </div>
    </div>
  );
}
