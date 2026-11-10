import { FormEvent, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ArrowRight, Mail } from "lucide-react";
import { useNavigate } from "react-router";

function extractInvitationToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, window.location.origin);
    const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  if (!trimmed.includes("/") && !/\s/.test(trimmed)) return trimmed;
  return null;
}

export function InviteLookupClient() {
  const navigateTo = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = extractInvitationToken(value);
    if (!token) {
      setError("Enter a valid invitation link or token.");
      return;
    }
    setError("");
    navigateTo("/invite/" + encodeURIComponent(token));
  }

  return (
    <div>
      <span className="inline-flex size-11 items-center justify-center rounded-full border border-[#182b2524] bg-[#f4f2ea] text-[#4f6b2a]">
        <Mail size={19} aria-hidden="true" />
      </span>
      <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#617168]">Organization invitation</p>
      <h1 className="auth-card-title mt-2">Redeem invitation.</h1>
      <p className="auth-card-description">
        Paste the invitation link from your email to join the workspace.
      </p>

      <form onSubmit={handleSubmit} className="auth-card-form space-y-4">
        <div>
          <label htmlFor="invitation" className="mb-1.5 block text-[13px] font-medium text-[#182b25]">
            Invitation link or token
          </label>
          <input
            id="invitation"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError("");
            }}
            placeholder="https://.../invite/..."
            autoComplete="off"
            autoFocus
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "invitation-error" : undefined}
            className="h-11 w-full rounded-md border border-[#182b2538] bg-[#fffdf8] px-3 text-sm text-[#182b25] outline-none placeholder:text-[#8a9189] focus:border-[#4f6b2a] focus:ring-2 focus:ring-[#69923633]"
          />
        </div>
        {error && (
          <p id="invitation-error" role="alert" className="text-sm text-[#a83c34]">
            {error}
          </p>
        )}
        <button type="submit" className="auth-primary">
          Continue
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </form>

      <Link to="/login" className="auth-secondary inline-flex w-full items-center justify-center gap-1.5">
        <ArrowLeft size={14} aria-hidden="true" />
        Back to sign in
      </Link>
    </div>
  );
}
