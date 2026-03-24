import LoginForm from "@/components/auth/login-form";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Sign In | KasiTek",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await getRustSession();
  if (session?.user?.id) {
    redirect("/workspace");
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Welcome back
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Sign in to Kasi<span className="text-primary">Tek</span>
        </h1>
        <p className="mt-2 text-muted-foreground">
          Access your workspace, products, and connected automation flows.
        </p>
      </div>
      <LoginForm searchParams={searchParams} />
    </div>
  );
}
