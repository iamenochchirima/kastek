import Link from "@/lib/link";
import { ArrowRight, Chrome, ShieldCheck } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";

export default function PartnerLoginScreen({
  intent = "login",
  error,
}: {
  intent?: "login" | "register";
  error?: string;
}) {
  const register = intent === "register";
  function start(google = false) {
    const params = new URLSearchParams();
    if (register) params.set("intent", "register");
    if (google) params.set("provider", "google");
    window.location.assign(
      `/api/tenant/api/partner/auth/start${params.size ? `?${params}` : ""}`,
    );
  }
  return (
    <AuthShell>
      <p className="auth-kicker">One KasiTek account</p>
      <h1 className="auth-card-title mt-3">
        {register ? "Make it your business." : "Welcome back."}
      </h1>
      <p className="auth-card-description">
        {register
          ? "Create your partner account, then set up your first white-label business."
          : "Sign in to manage your businesses, your team and your client portals."}
      </p>

      {error && <p className="auth-error mt-5" role="alert">{error}</p>}

      <button className="auth-primary mt-7" onClick={() => start()}>
        {register ? "Continue to create account" : "Continue with email or passkey"}
        <ArrowRight size={17} aria-hidden="true" />
      </button>
      <button
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-[#171a221f] bg-transparent px-4 text-sm font-medium text-[#171a22]"
        onClick={() => start(true)}
      >
        <Chrome size={16} aria-hidden="true" />
        Continue with Google
      </button>

      <p className="auth-secondary">
        {register ? "Already have an account? " : "New here? "}
        <Link href={register ? "/login?audience=partner" : "/register"}>
          {register ? "Sign in" : "Create an account"}
        </Link>
      </p>

      {register && (
        <p className="mt-3 text-[11px] leading-5 text-[#626874]">
          Email registration requires verification.
        </p>
      )}

      <p className="auth-security">
        <ShieldCheck size={15} aria-hidden="true" />
        Partner access uses KasiTek Identity. Your password and passkeys are
        never stored in this workspace.
      </p>
    </AuthShell>
  );
}
