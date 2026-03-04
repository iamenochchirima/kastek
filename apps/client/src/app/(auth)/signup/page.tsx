import SignupForm from "@/components/auth/signup-form";

export const metadata = {
  title: "Sign Up | KasiTek",
};

export default function SignupPage() {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="font-serif text-3xl text-text">
          Create your Kasi<span className="text-accent">Tek</span> account
        </h1>
        <p className="mt-2 text-text-muted">
          Get started with your AI-powered business dashboard
        </p>
      </div>
      <SignupForm />
    </div>
  );
}
