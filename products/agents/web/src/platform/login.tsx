import { ArrowRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import "./auth.css";

const errors: Record<string, string> = {
  expired: "Your sign-in attempt expired. Try again.",
  verification: "Verify your email through KasiTek sign-in, then try again.",
  unavailable: "Sign-in is unavailable. Try again shortly.",
  failed: "Sign-in was cancelled or could not finish. Try again.",
};

export function Login({ signup = false }: { signup?: boolean }) {
  const [parameters] = useSearchParams();
  const returnTo = parameters.get("returnTo") ?? "/app";
  const query = new URLSearchParams({ returnTo }).toString();
  const error = errors[parameters.get("error") ?? ""];

  return (
    <div className="authPage">
      <div className="authShell">
        <header className="authTopbar">
          <Link to="/" className="authBrand" aria-label="KasiTek Agents home">
            kasitek<span>/ agents</span>
          </Link>
          <Link to="/" className="authHome">
            Back to home <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </header>

        <main className="authMain">
          <section className="authCard" aria-labelledby="agents-auth-title">
            <h1 id="agents-auth-title" className="authCardTitle">
              {signup ? "Create your account." : "Welcome back."}
            </h1>
            <p className="authCardDescription">
              {signup
                ? "Create your KasiTek account. Email, Google and passkeys are supported."
                : "Sign in to manage your agents and customer conversations. Email, Google and passkeys are supported."}
            </p>

            {error && <p className="authError" role="alert" style={{ marginTop: 18 }}>{error}</p>}
            {parameters.get("logout") === "local" && (
              <p role="status" className="authNote">Signed out of Agents. Shared sign-out is unavailable.</p>
            )}

            <a className="authPrimary" href={`/api/auth/${signup ? "signup" : "login"}?${query}`} style={{ marginTop: 24 }}>
              {signup ? "Continue to create account" : "Continue to sign in"}
              <ArrowRight size={17} aria-hidden="true" />
            </a>

            <p className="authSecondary">
              {signup ? "Already have an account? " : "New to KasiTek? "}
              <Link to={`${signup ? "/login" : "/signup"}?${query}`}>
                {signup ? "Sign in" : "Create an account"}
              </Link>
            </p>

            <p className="authSecurity">
              <ShieldCheck size={15} aria-hidden="true" />
              Secure sign-in through KasiTek Identity. Your password and passkeys
              are never stored in this workspace.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}

export function Signup() { return <Login signup />; }
