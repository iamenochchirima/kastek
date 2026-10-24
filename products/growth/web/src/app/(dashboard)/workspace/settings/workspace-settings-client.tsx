import type { Org } from "@/lib/orgs";
import type { BillingCredits, BillingSummary, AvailablePlan, BillingUsage } from "@/lib/billing";
import { apiUrl } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { BarChart3, Bell, Building2, CreditCard, ImagePlus, Palette, Upload, UserRound, X } from "lucide-react";
import { Link } from "react-router";
import { useNavigate, useRevalidator } from "react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { AppearancePanel } from "@/components/dashboard/settings/appearance-panel";
import { WorkspaceNotificationsPanel } from "@/components/dashboard/settings/workspace-notifications-panel";
import { BillingPanel } from "@/components/dashboard/billing/billing-panel";
import { UsagePanel } from "@/components/dashboard/billing/usage-panel";
import ProfileForm from "@/components/dashboard/profile/profile-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { VANTAGE_EXPO, VANTAGE_MOTION, VANTAGE_SELECTION_SPRING } from "@/lib/motion";
import { useAppearance } from "@/lib/appearance";

export type LocalSettingsTab = "profile" | "organization" | "appearance" | "notifications" | "billing" | "usage";

export type WorkspaceProfile = {
  user: {
    name: string | null;
    email: string | null;
    emailVerified: string | null;
    phone: string | null;
    image: string | null;
  };
};

const SETTINGS_LINKS = [
  { id: "profile", label: "Profile", icon: UserRound },
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "billing", label: "Billing", icon: CreditCard },
  { id: "usage", label: "Usage", icon: BarChart3 },
] as const;

export function WorkspaceSettingsClient({
  org,
  canManage,
  profile,
  initialTab,
  billingSummary,
  billingPlans,
  billingCredits,
  billingUsage,
  billingQuery,
}: {
  org: Org;
  canManage: boolean;
  profile: WorkspaceProfile;
  initialTab: LocalSettingsTab;
  billingSummary: BillingSummary | null;
  billingPlans: { plans: AvailablePlan[] };
  billingCredits: BillingCredits | null;
  billingUsage: BillingUsage | null;
  billingQuery: { payment?: string; reference?: string; trxref?: string };
}) {
  const navigateTo = useNavigate();
  const revalidator = useRevalidator();
  const appearance = useAppearance();
  const [tab, setTab] = useState<LocalSettingsTab>(initialTab);
  const [name, setName] = useState(org.name);
  const [logo, setLogo] = useState(org.logo || "");
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  function selectTab(nextTab: LocalSettingsTab) {
    setTab(nextTab);
    const query = `?section=${nextTab}`;
    navigateTo(`/workspace/settings${query}`, { preventScrollReset: true });
  }

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const preview = URL.createObjectURL(logoFile);
    setLogoPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [logoFile]);

  function chooseLogo(file: File | null) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setMessage("Use a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setMessage("Organization logos must be 5 MB or smaller.");
      return;
    }
    setMessage("");
    setLogoFile(file);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      let nextLogo = logo.trim() || null;
      if (logoFile) {
        const formData = new FormData();
        formData.append("file", logoFile);
        const uploadResponse = await fetch(apiUrl(`/api/orgs/${org.id}/logo`), {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        const uploadBody = await uploadResponse.json().catch(() => ({}));
        if (!uploadResponse.ok || !uploadBody.org?.logo) {
          throw new Error(uploadBody.error || "Failed to upload organization logo");
        }
        nextLogo = uploadBody.org.logo;
      }
      const response = await fetch(apiUrl(`/api/orgs/${org.id}`), {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, logo: nextLogo }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Failed to update workspace");
      setLogo(nextLogo || "");
      setLogoFile(null);
      toast.success("Settings saved");
      revalidator.revalidate();
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
          <p className="mt-1 text-[13px] text-muted-foreground">Manage your workspace settings and billing.</p>
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

          <div className="min-w-0 w-full max-w-[1080px] flex-1">
            <AnimatePresence initial={false} mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: VANTAGE_MOTION.shell / 1000, ease: VANTAGE_EXPO }}>
            {tab === "profile" ? (
              <div className="space-y-5">
                <ProfileForm user={{ ...profile.user, emailVerified: !!profile.user.emailVerified }} />
                <section className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
                  <h2 className="text-base font-semibold text-foreground">Workspace access</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Manage the people in this workspace.</p>
                  <Button asChild variant="outline" className="mt-4"><Link to="/workspace/team">Team</Link></Button>
                </section>
              </div>
            ) : tab === "appearance" ? <AppearancePanel /> : tab === "notifications" ? <WorkspaceNotificationsPanel /> : tab === "billing" ? <BillingPanel embedded summary={billingSummary} planResponse={billingPlans} billingCredits={billingCredits} query={billingQuery} /> : tab === "usage" ? <UsagePanel embedded usage={billingUsage} credits={billingCredits} /> : tab === "organization" ? (
              <section className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
                <h2 className="text-base font-semibold text-foreground">Organization settings</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Manage the identity shown across KasiTek.</p>
                {message ? <p className="mt-3 text-sm text-destructive" role="alert">{message}</p> : null}
                <div className="mt-5 grid max-w-xl gap-4">
                  <label className="text-sm"><span className="text-muted-foreground">Organization name</span><Input disabled={!canManage} value={name} onChange={(event) => setName(event.target.value)} className="mt-2" /></label>
                  <div className="text-sm">
                    <span className="text-muted-foreground">Organization logo</span>
                    <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/20 p-3">
                      <Avatar className="size-14 rounded-lg border border-border bg-background">
                        <AvatarImage src={logoPreview || logo || undefined} alt="Organization logo preview" className="rounded-lg object-cover" />
                        <AvatarFallback className="rounded-lg bg-primary/10 text-primary"><ImagePlus className="size-5" /></AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button type="button" variant="outline" size="sm" disabled={!canManage || saving} onClick={() => document.getElementById("organization-logo-upload")?.click()}>
                            <Upload className="mr-1.5 size-3.5" />Upload image
                          </Button>
                          {(logo || logoFile) && canManage ? <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => { setLogo(""); setLogoFile(null); }}><X className="mr-1.5 size-3.5" />Remove</Button> : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">PNG, JPEG, WebP, or GIF · up to 5 MB</p>
                      </div>
                      <input id="organization-logo-upload" type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" disabled={!canManage || saving} onChange={(event) => { chooseLogo(event.target.files?.[0] ?? null); event.currentTarget.value = ""; }} />
                    </div>
                    <label className="mt-3 block text-xs text-muted-foreground">Or use an image URL<Input disabled={!canManage || saving || !!logoFile} value={logo} onChange={(event) => setLogo(event.target.value)} placeholder="https://…" className="mt-1.5 text-sm" /></label>
                  </div>
                </div>
                {canManage ? <Button type="button" onClick={save} disabled={saving || !name.trim()} className="mt-5">{saving ? "Saving…" : "Save changes"}</Button> : null}
              </section>
            ) : null}
            </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
    </MotionConfig>
  );
}
