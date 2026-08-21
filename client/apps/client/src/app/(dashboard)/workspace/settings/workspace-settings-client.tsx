"use client";

import type { Org } from "@/lib/orgs";
import { apiUrl } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { Bell, CreditCard, KeyRound, Palette, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AppearancePanel } from "@/components/dashboard/settings/appearance-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VANTAGE_EXPO, VANTAGE_SELECTION_SPRING } from "@/lib/motion";
import { useAppearance } from "@/lib/appearance";

type LocalSettingsTab = "general" | "appearance";

const SETTINGS_LINKS = [
  { label: "Notifications", href: "/workspace/notifications", icon: Bell },
  { label: "API Keys", href: "/developers/api-keys", icon: KeyRound },
  { label: "Billing", href: "/billing", icon: CreditCard },
] as const;

export function WorkspaceSettingsClient({
  org,
  canManage,
  initialTab,
}: {
  org: Org;
  canManage: boolean;
  initialTab: LocalSettingsTab;
}) {
  const router = useRouter();
  const appearance = useAppearance();
  const [tab, setTab] = useState<LocalSettingsTab>(initialTab);
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState(org.logo || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(apiUrl(`/api/orgs/${org.id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, logo: logo.trim() || null }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to update workspace");
      toast.success("Settings saved");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update workspace");
    } finally {
      setSaving(false);
    }
  }

  return (
    <MotionConfig reducedMotion={appearance.interface.reduceMotion ? "always" : "user"}>
    <div className="min-h-[100dvh] px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px]">
        <header>
          <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-foreground">Settings</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Manage your workspace, appearance, notifications, API keys and billing.</p>
        </header>

        <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-start">
          <nav aria-label="Settings sections" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:w-[200px] md:flex-col md:overflow-visible md:px-0 md:pb-0">
            <Link href="/workspace/settings" aria-current={tab === "general" ? "page" : undefined} className={cn("relative flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors", tab === "general" ? "text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
              {tab === "general" ? <motion.span layoutId="settings-tab-active" transition={VANTAGE_SELECTION_SPRING} className="absolute inset-0 rounded-md bg-primary/10" /> : null}
              <SlidersHorizontal className="relative z-10" size={16} />
              <span className="relative z-10">General</span>
            </Link>
            <Link href="/workspace/settings?section=appearance" aria-current={tab === "appearance" ? "page" : undefined} className={cn("relative flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors", tab === "appearance" ? "text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
              {tab === "appearance" ? <motion.span layoutId="settings-tab-active" transition={VANTAGE_SELECTION_SPRING} className="absolute inset-0 rounded-md bg-primary/10" /> : null}
              <Palette className="relative z-10" size={16} />
              <span className="relative z-10">Appearance</span>
            </Link>
            {SETTINGS_LINKS.map(({ label, href, icon: Icon }) => (
              <Link key={href} href={href} className="flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                <Icon size={16} />
                <span>{label}</span>
              </Link>
            ))}
          </nav>

          <div className="min-w-0 w-full max-w-[760px] flex-1">
            <AnimatePresence initial={false} mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25, ease: VANTAGE_EXPO }}>
            {tab === "appearance" ? <AppearancePanel /> : (
              <div className="flex flex-col gap-5">
                <section className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
                  <h2 className="text-base font-semibold text-foreground">Business identity</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Workspace details shown across KasiTek.</p>
                  {message ? <p className="mt-3 text-sm text-destructive" role="alert">{message}</p> : null}
                  <div className="mt-5 grid max-w-xl gap-4">
                    <label className="text-sm"><span className="text-muted-foreground">Workspace name</span><Input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label>
                    <label className="text-sm"><span className="text-muted-foreground">Logo URL</span><Input disabled={!canManage} value={logo} onChange={(event) => setLogo(event.target.value)} placeholder="https://…" className="mt-2" /></label>
                  </div>
                  {canManage ? <Button type="button" onClick={save} disabled={saving || !name.trim()} className="mt-5">{saving ? "Saving…" : "Save changes"}</Button> : null}
                </section>

                <section className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
                  <h2 className="text-base font-semibold text-foreground">Workspace access</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Manage people and your personal profile.</p>
                  <div className="mt-4 flex flex-wrap gap-3">
                    <Button asChild variant="outline"><Link href="/workspace/profile">Profile</Link></Button>
                    <Button asChild variant="outline"><Link href="/workspace/team">Team</Link></Button>
                  </div>
                </section>
              </div>
            )}
            </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
    </MotionConfig>
  );
}
