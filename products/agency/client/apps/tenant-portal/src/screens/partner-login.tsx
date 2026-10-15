import Link from "@/lib/link";
import { ArrowRight } from "lucide-react";
import "@/styles/marketing.css";
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
    <div className="marketing marketing-auth">
      <Link href="/" className="marketing-brand">
        kasitek<span>/ agency</span>
      </Link>
      <section>
        <p className="marketing-kicker">One KasiTek account</p>
        <h1>{register ? "Make it your business." : "Welcome back."}</h1>
        <p>
          Create and manage your white-label businesses. Sign in with your
          email, Google account or passkey through shared KasiTek sign-in.
        </p>
        {error && <p role="alert">{error}</p>}
        <button className="marketing-cta" onClick={() => start()}>
          {register ? "Create your account" : "Continue with email or passkey"}
          <ArrowRight size={18} />
        </button>
        <button
          className="marketing-auth-secondary"
          onClick={() => start(true)}
        >
          Continue with Google
        </button>
        {register && (
          <p className="marketing-footnote">
            Email registration requires verification.
          </p>
        )}
        <Link href={register ? "/login?audience=partner" : "/register"}>
          {register
            ? "Already have an account? Sign in"
            : "New here? Create an account"}
        </Link>
      </section>
    </div>
  );
}
