import SignupForm from "@/components/auth/signup-form";

export const metadata = {
  title: "Sign Up | KasiTek",
};

export default function SignupPage() {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Get started
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Create your Kasi<span className="text-primary">Tek</span> account
        </h1>
        <p className="mt-2 text-muted-foreground">
          Set up your workspace and start using KasiTek products.
        </p>
      </div>
      <SignupForm />
    </div>
  );
}
