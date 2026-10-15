"use client";

import { apiUrl } from "@/lib/server-api";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SignOutButton from "@/components/auth/sign-out-button";

type ProfileFormProps = {
  user: {
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    image: string | null;
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
      ? "border-destructive/30 bg-status-danger-soft text-destructive"
      : tone === "success"
        ? "border-status-success/30 bg-status-success-soft text-status-success"
        : "border-border bg-secondary text-muted-foreground";

  return <div className={`rounded-xl border px-4 py-3 text-sm ${classes}`}>{message}</div>;
}

export default function ProfileForm({ user }: ProfileFormProps) {
  const router = useRouter();

  const [name, setName] = useState(user.name || "");
  const [phone, setPhone] = useState(user.phone || "");
  const [image, setImage] = useState(user.image || "");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [profileNotice, setProfileNotice] = useState("");

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

  const initials = (name || user.email || "K")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <form onSubmit={onProfileSubmit} className="rounded-xl border border-border bg-card p-6">
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
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Your name"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-foreground">Phone</span>
              <Input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+27 72 123 4567"
              />
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-sm font-medium text-foreground">Photo URL</span>
              <Input
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder="https://..."
              />
            </label>
          </div>

          <div className="mt-6">
            <Button
              type="submit"
              disabled={savingProfile}
            >
              {savingProfile ? "Saving..." : "Save profile"}
            </Button>
          </div>
        </form>

        <section className="space-y-4 rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold">Account security</h2>
          <p className="break-all text-sm text-muted-foreground">{user.email}</p>
          <p className="text-sm text-muted-foreground">Manage password, Google, passkeys and two-factor authentication.</p>
          <Button asChild variant="outline"><a href={apiUrl("/api/auth/account")}>Manage account</a></Button>
          <div className="flex flex-wrap gap-3">
            <SignOutButton />
            <SignOutButton allDevices />
          </div>
        </section>
      </div>

      <aside className="rounded-xl border border-border bg-card p-6">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Preview</div>

        <div className="mt-5 rounded-xl border border-border bg-secondary/50 p-5">
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
