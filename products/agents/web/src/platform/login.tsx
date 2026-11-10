import { ArrowRight, ArrowUpRight, Check, Chrome, Fingerprint, Mail, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import "./auth.css";

const errors: Record<string, string> = {
  expired: "Your sign-in attempt expired. Try again.",
  verification: "Verify your email through KasiTek sign-in, then try again.",
  unavailable: "Sign-in is unavailable. Try again shortly.",
  failed: "Sign-in was cancelled or could not finish. Try again.",
};

const methods = [
  { label: "Email", Icon: Mail },
  { label: "Google", Icon: Chrome },
  { label: "Passkey", Icon: Fingerprint },
];

const points = [
  "Answers grounded in your knowledge and tools",
  "Human handoff when a conversation needs a person",
  "One inbox across website, WhatsApp and social",
];

export function Login({ signup = false }: { signup?: boolean }) {
  const [parameters] = useSearchParams();
  const returnTo = parameters.get("returnTo") ?? "/app";
  const query = new URLSearchParams({ returnTo }).toString();
  const error = errors[parameters.get("error") ?? ""];

  return (
    <div className="authPage">
      <aside className="authStory">
        <Link to="/" className="authBrand" aria-label="KasiTek Agents home">
          kasitek<span>/ agents</span>
        </Link>

        <div className="authStoryCopy">
          <p className="authKicker">KasiTek Agents</p>
          <p className="authStoryHeadline">
            Answers that
            <br />
            feel <em>human.</em>
          </p>
          <p>
            Customer service agents that answer questions, handle enquiries and
            manage bookings with your knowledge and connected tools.
          </p>
          <ul className="authPoints">
            {points.map((point) => (
              <li key={point}>
                <Check size={16} aria-hidden="true" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <p className="authStoryFoot">
          <span aria-hidden="true" />
          Built for teams that care about the reply.
        </p>
      </aside>

      <main className="authSide">
        <div className="authTop">
          <Link to="/" className="authHome">
            Back to home <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </div>

        <div className="authSideMain">
          <section className="authCard" aria-labelledby="agents-auth-title">
            <p className="authKicker" style={{ color: "#626874" }}>Workspace access</p>
            <h1 id="agents-auth-title" className="authCardTitle" style={{ marginTop: 12 }}>
              {signup ? "Create your account." : "Welcome back."}
            </h1>
            <p className="authCardDescription">
              {signup
                ? "Create a KasiTek account, then set up your first customer-service agent."
                : "Sign in to manage your agents, conversations and customer knowledge."}
            </p>

            {error && <p className="authError" role="alert" style={{ marginTop: 20 }}>{error}</p>}
            {parameters.get("logout") === "local" && (
              <p role="status" className="authNote">Signed out of Agents. Shared sign-out is unavailable.</p>
            )}

            <div className="authMethods" aria-label="Supported sign-in methods">
              {methods.map(({ label, Icon }) => (
                <span key={label} className="authMethod">
                  <Icon size={14} aria-hidden="true" />
                  {label}
                </span>
              ))}
            </div>

            <a className="authPrimary" href={`/api/auth/${signup ? "signup" : "login"}?${query}`}>
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
        </div>
      </main>
    </div>
  );
}

export function Signup() { return <Login signup />; }
