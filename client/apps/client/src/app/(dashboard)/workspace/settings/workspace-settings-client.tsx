"use client";

import type { Org } from "@/lib/orgs";
import type { BillingSummary, AvailablePlan } from "@/lib/billing";
import { apiUrl } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { Bell, Building2, CreditCard, Palette, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AppearancePanel } from "@/components/dashboard/settings/appearance-panel";
import { WorkspaceNotificationsPanel } from "@/components/dashboard/settings/workspace-notifications-panel";
import { BillingPanel } from "@/components/dashboard/billing/billing-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VANTAGE_EXPO, VANTAGE_MOTION, VANTAGE_SELECTION_SPRING } from "@/lib/motion";
import { useAppearance } from "@/lib/appearance";

export type LocalSettingsTab = "general" | "organization" | "appearance" | "notifications" | "billing";

const SETTINGS_LINKS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "billing", label: "Billing", icon: CreditCard },
] as const;

export function WorkspaceSettingsClient({
  org,
  canManage,
  initialTab,
  billingSummary,
  billingPlans,
  billingQuery,
}: {
  org: Org;
  canManage: boolean;
  initialTab: LocalSettingsTab;
  billingSummary: BillingSummary | null;
  billingPlans: { plans: AvailablePlan[] };
  billingQuery: { payment?: string; reference?: string; trxref?: string };
}) {
  const router = useRouter();
  const appearance = useAppearance();
  const [tab, setTab] = useState<LocalSettingsTab>(initialTab);
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState(org.logo || "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  function selectTab(nextTab: LocalSettingsTab) {
    setTab(nextTab);
    const query = nextTab === "general" ? "" : `?section=${nextTab}`;
    router.push(`/workspace/settings${query}`, { scroll: false });
  }

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
          <p className="mt-1 text-[13px] text-muted-foreground">Manage your organization, appearance, notifications, and billing.</p>
        </header>

        <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-start">
          <nav aria-label="Settings sections" className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:w-[200px] md:flex-col md:overflow-visible md:px-0 md:pb-0">
            {SETTINGS_LINKS.map(({ id, label, icon: Icon }) => {
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectTab(id)}
                  aria-current={active ? "page" : undefined}
                  className={cn("relative flex h-10 shrink-0 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
                >
                  {active ? <motion.span layoutId="settings-tab-active" transition={VANTAGE_SELECTION_SPRING} className="absolute inset-0 rounded-md bg-primary/10" /> : null}
                  <Icon className="relative z-10" size={16} />
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 w-full max-w-[760px] flex-1">
            <AnimatePresence initial={false} mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: VANTAGE_MOTION.shell / 1000, ease: VANTAGE_EXPO }}>
            {tab === "appearance" ? <AppearancePanel /> : tab === "notifications" ? <WorkspaceNotificationsPanel /> : tab === "billing" ? <BillingPanel embedded summary={billingSummary} planResponse={billingPlans} query={billingQuery} /> : tab === "organization" ? (
              <section className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
                <h2 className="text-base font-semibold text-foreground">Organization settings</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Manage the identity shown across KasiTek.</p>
                {message ? <p className="mt-3 text-sm text-destructive" role="alert">{message}</p> : null}
                <div className="mt-5 grid max-w-xl gap-4">
                  <label className="text-sm"><span className="text-muted-foreground">Organization name</span><Input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label>
                  <label className="text-sm"><span className="text-muted-foreground">Organization logo</span><Input disabled={!canManage} value={logo} onChange={(event) => setLogo(event.target.value)} placeholder="https://…" className="mt-2" /></label>
                </div>
                {canManage ? <Button type="button" onClick={save} disabled={saving || !name.trim()} className="mt-5">{saving ? "Saving…" : "Save changes"}</Button> : null}
              </section>
            ) : (
              <div className="flex flex-col gap-5">
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
