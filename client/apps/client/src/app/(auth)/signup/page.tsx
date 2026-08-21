import SignupForm from "@/components/auth/signup-form";

export const metadata = {
  title: "Sign Up | KasiTek",
};

export default function SignupPage() {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h1 className="text-[24px] leading-8 font-semibold tracking-[-0.02em] text-ink-1">Create account</h1>
      </div>
      <SignupForm />
    </div>
  );
}
