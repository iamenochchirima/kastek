import { ArrowRight } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import "@/styles/marketing.css";

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
  return <div className="marketing marketing-auth">
    <Link to="/" className="marketing-brand">kasitek<span>/ agents</span></Link>
    <main><section>
      <p className="marketing-kicker">KasiTek Agents</p>
      <h1>{signup ? "Create your account." : "Welcome back."}</h1>
      <p>{signup ? "Continue to KasiTek to register and verify your email." : "Continue with your KasiTek account."}</p>
      {error && <p className="marketing-auth-error" role="alert">{error}</p>}
      {parameters.get("logout") === "local" && <p role="status">Signed out of Agents. Shared sign-out is unavailable.</p>}
      <a className="marketing-cta" href={`/api/auth/${signup ? "signup" : "login"}?${query}`}>{signup ? "Create account" : "Sign in"}<ArrowRight size={18} aria-hidden="true" /></a>
      <Link to={`${signup ? "/login" : "/signup"}?${query}`}>{signup ? "Already have an account? Sign in" : "Create an account"}</Link>
    </section></main>
  </div>;
}

export function Signup() { return <Login signup />; }
