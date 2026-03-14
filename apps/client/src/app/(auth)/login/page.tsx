import LoginForm from "@/components/auth/login-form";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Sign In | KasiTek",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/dashboard");
  }

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="font-serif text-3xl text-text">
          Sign in to Kasi<span className="text-accent">Tek</span>
        </h1>
        <p className="mt-2 text-text-muted">
          Get started with your AI-powered business dashboard
        </p>
      </div>
      <LoginForm searchParams={searchParams} />
    </div>
  );
}
