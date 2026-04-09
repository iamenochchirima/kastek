"use client";

import { apiUrl } from "@/lib/server-api";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type ProfileFormProps = {
  user: {
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    image: string | null;
    hasPassword: boolean;
  };
};

function Notice({
  tone,
  message,
}: {
  tone: "error" | "success" | "info";
  message: string;
}) {
  const classes =
    tone === "error"
      ? "border-red-500/30 bg-red-500/10 text-red-300"
      : tone === "success"
        ? "border-green-500/30 bg-green-500/10 text-green-300"
        : "border-border bg-secondary text-muted-foreground";

  return <div className={`rounded-xl border px-4 py-3 text-sm ${classes}`}>{message}</div>;
}

export default function ProfileForm({ user }: ProfileFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState(user.name || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [image, setImage] = useState(user.image || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");

  const [nextEmail, setNextEmail] = useState(user.email || "");
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailNotice, setEmailNotice] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");

  useEffect(() => {
    const emailChange = searchParams.get("emailChange");
    if (emailChange === "success") {
      setEmailNotice("Email address updated successfully.");
      setEmailError("");
    } else if (emailChange === "conflict") {
      setEmailError("That email address is no longer available. Try another one.");
      setEmailNotice("");
    }
  }, [searchParams]);

  async function onProfileSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingProfile(true);
    setProfileError("");
    setProfileNotice("");

    try {
      const res = await fetch(apiUrl("/api/profile"), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
          image: image.trim(),
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to update profile");
      }

      setProfileNotice("Profile updated.");
      router.refresh();
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to update profile");
    } finally {
      setSavingProfile(false);
    }
  }

  async function onEmailSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailSaving(true);
    setEmailError("");
    setEmailNotice("");

    try {
      const res = await fetch(apiUrl("/api/profile/email"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: nextEmail.trim() }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to start email change");
      }

      setEmailNotice(body.message || "Verification email sent.");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Failed to start email change");
    } finally {
      setEmailSaving(false);
    }
  }

  async function onPasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordSaving(true);
    setPasswordError("");
    setPasswordNotice("");

    try {
      if (nextPassword.length < 8) {
        throw new Error("New password must be at least 8 characters");
      }

      if (nextPassword !== confirmPassword) {
        throw new Error("New password and confirmation do not match");
      }

      const res = await fetch(apiUrl("/api/profile/password"), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          nextPassword,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to update password");
      }

      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setPasswordNotice(body.message || "Password updated.");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setPasswordSaving(false);
    }
  }

  const initials = (name || user.email || "K")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <form onSubmit={onProfileSubmit} className="rounded-2xl border border-border bg-card p-6">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Personal details</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Update the identity shown around the workspace.
            </p>
          </div>

          {(profileError || profileNotice) &&
            (profileError ? (
              <div className="mb-5">
                <Notice tone="error" message={profileError} />
              </div>
            ) : (
              <div className="mb-5">
                <Notice tone="success" message={profileNotice} />
              </div>
            ))}

          <div className="grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Full name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Phone</span>
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+27 72 123 4567"
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-sm font-medium text-foreground">Photo URL</span>
              <input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="https://..."
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-6">
            <button
              type="submit"
              disabled={savingProfile}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
            >
              {savingProfile ? "Saving..." : "Save profile"}
            </button>
          </div>
        </form>

        <form onSubmit={onEmailSubmit} className="rounded-2xl border border-border bg-card p-6">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Email address</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Change your sign-in email. We will verify the new address before switching it.
            </p>
          </div>

          <div className="mb-4 grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Current email</span>
              <input
                value={user.email || ""}
                readOnly
                className="w-full rounded-xl border border-border bg-secondary/70 px-4 py-3 text-sm text-muted-foreground outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">New email</span>
              <input
                value={nextEmail}
                onChange={(event) => setNextEmail(event.target.value)}
                placeholder="name@example.com"
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
              />
            </label>
          </div>

          <div className="mb-4">
            <Notice
              tone="info"
              message={
                user.emailVerified
                  ? "Your current email is verified."
                  : "Your current email is not verified yet."
              }
            />
          </div>

          {(emailError || emailNotice) &&
            (emailError ? (
              <div className="mb-4">
                <Notice tone="error" message={emailError} />
              </div>
            ) : (
              <div className="mb-4">
                <Notice tone="success" message={emailNotice} />
              </div>
            ))}

          <button
            type="submit"
            disabled={emailSaving}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {emailSaving ? "Sending..." : "Send verification link"}
          </button>
        </form>

        <form onSubmit={onPasswordSubmit} className="rounded-2xl border border-border bg-card p-6">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Password</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {user.hasPassword
                ? "Change your current password."
                : "You do not have a password yet. Set one now for email sign-in."}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {user.hasPassword ? (
              <label className="block md:col-span-2">
                <span className="mb-2 block text-sm font-medium text-foreground">Current password</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground focus:border-primary focus:outline-none"
                />
              </label>
            ) : null}

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">New password</span>
              <input
                type="password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Confirm new password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="w-full rounded-xl border border-border bg-secondary px-4 py-3 text-sm text-foreground focus:border-primary focus:outline-none"
              />
            </label>
          </div>

          {(passwordError || passwordNotice) &&
            (passwordError ? (
              <div className="mb-4 mt-4">
                <Notice tone="error" message={passwordError} />
              </div>
            ) : (
              <div className="mb-4 mt-4">
                <Notice tone="success" message={passwordNotice} />
              </div>
            ))}

          <div className="mt-5">
            <button
              type="submit"
              disabled={passwordSaving}
              className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:-translate-y-0.5 disabled:opacity-50 disabled:hover:translate-y-0"
            >
              {passwordSaving ? "Saving..." : user.hasPassword ? "Change password" : "Set password"}
            </button>
          </div>
        </form>
      </div>

      <aside className="rounded-2xl border border-border bg-card p-6">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Preview</div>

        <div className="mt-5 rounded-2xl border border-border bg-secondary/50 p-5">
          {image ? (
            <div
              aria-hidden="true"
              className="h-20 w-20 rounded-3xl border border-border bg-cover bg-center"
              style={{ backgroundImage: `url("${image}")` }}
            />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-3xl border border-primary/20 bg-primary/10 text-2xl font-semibold text-primary">
              {initials || "K"}
            </div>
          )}

          <div className="mt-4">
            <div className="text-lg font-semibold tracking-tight text-foreground">{name || "Your name"}</div>
            <div className="mt-1 text-sm text-muted-foreground">{user.email || "No email"}</div>
            <div className="mt-3 text-sm text-muted-foreground">{phone || "No phone number added yet"}</div>
          </div>
        </div>
      </aside>
    </div>
  );
}
