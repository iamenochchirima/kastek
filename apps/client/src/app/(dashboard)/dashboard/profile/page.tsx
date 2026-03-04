import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import ProfileForm from "@/components/dashboard/profile/profile-form";

export const metadata = {
  title: "Profile | KasiAI",
};

export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      email: true,
      emailVerified: true,
      phone: true,
      image: true,
      password: true,
    },
  });

  if (!user) redirect("/login");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-semibold tracking-tight">Profile</h1>
        <p className="text-text-muted">
          Manage your personal account details separately from workspace integrations and channels.
        </p>
      </div>

      <ProfileForm
        user={{
          name: user.name,
          email: user.email,
          emailVerified: !!user.emailVerified,
          phone: user.phone,
          image: user.image,
          hasPassword: !!user.password,
        }}
      />
    </div>
  );
}
