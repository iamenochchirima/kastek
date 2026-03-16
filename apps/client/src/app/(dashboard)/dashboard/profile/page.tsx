import { auth } from "@/auth";
import ProfileForm from "@/components/dashboard/profile/profile-form";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Profile | KasiTek",
};

export default async function DashboardProfilePage() {
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
            name: user.name,
            email: user.email,
            emailVerified: !!user.emailVerified,
            phone: user.phone,
            image: user.image,
            hasPassword: !!user.password,
          }}
        />
      </div>
    </div>
  );
}
