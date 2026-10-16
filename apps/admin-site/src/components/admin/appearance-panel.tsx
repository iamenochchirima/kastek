"use client";

import Link from "next/link";
import { Check, KeyRound, Monitor, Moon, Sun } from "lucide-react";
import { ACCENTS, setAccent, setDensity, setInterfacePreference, setTheme, useAppearance, type AccentPreset, type ThemeMode } from "@/lib/appearance";
import { cn } from "@/lib/utils";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string; description: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", description: "Crisp and bright", icon: Sun },
  { id: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  { id: "system", label: "System", description: "Follows your device", icon: Monitor },
];

const INTERFACE_OPTIONS: ReadonlyArray<{ key: "reduceMotion" | "liveIndicators" | "weekStartsMonday"; title: string; description: string }> = [
  { key: "reduceMotion", title: "Reduce motion", description: "Minimise non-essential transitions and pulses." },
  { key: "liveIndicators", title: "Show live indicators", description: "Show activity and health indicators when available." },
  { key: "weekStartsMonday", title: "Week starts on Monday", description: "Use Monday as the first day in weekly reports." },
];

type PreviewColors = {
  background: string;
  surface: string;
  line: string;
  ink: string;
  muted: string;
  brand: string;
};

function PreviewPanel({ colors }: { colors: PreviewColors }) {
  return <div className="h-full min-w-0 flex-1 p-2" style={{ background: colors.background }}>
    <div className="flex items-center gap-1.5"><span className="size-2 rounded-[3px]" style={{ background: colors.brand }} /><span className="h-1 w-10 rounded-full" style={{ background: colors.muted, opacity: .65 }} /></div>
    <div className="mt-2 grid grid-cols-3 gap-1">
      {[0, 1, 2].map((item) => <div key={item} className="rounded-[4px] border p-1" style={{ background: colors.surface, borderColor: colors.line }}><span className="block h-1 w-4 rounded-full" style={{ background: colors.muted, opacity: .55 }} /><span className="mt-1 block h-1.5 w-6 rounded-full" style={{ background: colors.ink, opacity: .85 }} /></div>)}
    </div>
    <div className="mt-2 rounded-[4px] border p-1.5" style={{ background: colors.surface, borderColor: colors.line }}>
      <svg viewBox="0 0 120 28" className="block h-8 w-full" preserveAspectRatio="none" aria-hidden="true"><path d="M0 22 L15 18 L30 20 L45 12 L60 15 L75 8 L90 11 L105 5 L120 8 L120 28 L0 28 Z" fill={colors.brand} opacity=".14" /><path d="M0 22 L15 18 L30 20 L45 12 L60 15 L75 8 L90 11 L105 5 L120 8" fill="none" stroke={colors.brand} strokeWidth="2" strokeLinecap="round" /></svg>
    </div>
  </div>;
}

function ThemePreview({ mode, accent }: { mode: ThemeMode; accent: AccentPreset }) {
  const light = { background: "#F6F7F9", surface: "#FFFFFF", line: "#E4E7ED", ink: "#0B1020", muted: "#8B94AB", brand: accent.light.base };
  const dark = { background: "#090B11", surface: "#10131C", line: "#1E2432", ink: "#F3F5F9", muted: "#5E6880", brand: accent.dark.base };

  if (mode === "system") return <div className="flex h-full overflow-hidden"><PreviewPanel colors={light} /><PreviewPanel colors={dark} /></div>;
  return <PreviewPanel colors={mode === "dark" ? dark : light} />;
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="v-card p-[var(--density-card-padding)]"><h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h2><p className="mt-0.5 text-xs text-muted-foreground">{description}</p><div className="mt-5">{children}</div></section>;
}

function PreferenceSwitch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cn("relative h-6 w-11 shrink-0 rounded-full border p-0.5 transition-colors", checked ? "border-transparent bg-primary" : "border-line-strong bg-surface-2")}><span className={cn("block size-4 rounded-full bg-white shadow-card transition-transform", checked ? "translate-x-5" : "translate-x-0")} /></button>;
}

export function AdminAppearancePanel() {
  const preferences = useAppearance();
  const selectedAccent = ACCENTS.find((accent) => accent.id === preferences.accent) ?? ACCENTS[0];

  return <div className="space-y-5">
    <Section title="Theme" description="Choose how the Admin workspace appears.">
      <div className="grid gap-3 sm:grid-cols-3">
        {MODES.map(({ id, label, description, icon: Icon }) => {
          const selected = preferences.theme === id;
          return <button key={id} type="button" onClick={() => setTheme(id)} aria-pressed={selected} className={cn("group rounded-lg text-left", "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background")}>
            <div className={cn("relative h-[128px] overflow-hidden rounded-md border transition-[border-color,box-shadow]", selected ? "border-transparent shadow-[0_0_0_2px_var(--appearance-accent)]" : "border-line group-hover:border-line-strong")}><ThemePreview mode={id} accent={selectedAccent} />{selected ? <span className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-pop"><Check size={12} strokeWidth={3} /></span> : null}</div>
            <div className="mt-2 flex items-center gap-1.5"><Icon size={14} className={selected ? "text-primary" : "text-muted-foreground"} /><span className={cn("text-[13px] font-medium", selected ? "text-foreground" : "text-muted-foreground")}>{label}</span><span className="text-[11px] text-muted-foreground">· {description}</span></div>
          </button>;
        })}
      </div>
    </Section>

    <Section title="Accent color" description="Changes actions, active states, and charts across Admin.">
      <div className="flex flex-wrap items-center gap-3">
        {ACCENTS.map((accent) => { const selected = accent.id === preferences.accent; return <button key={accent.id} type="button" title={accent.name} aria-label={`${accent.name} accent`} aria-pressed={selected} onClick={() => setAccent(accent.id)} className="relative grid size-8 place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" style={{ backgroundColor: accent.swatch }}><span className={cn("absolute -inset-1 rounded-full border-2 transition-opacity", selected ? "opacity-100" : "opacity-0")} style={{ borderColor: accent.swatch }} />{selected ? <Check size={14} strokeWidth={3.5} className="relative text-primary-foreground drop-shadow" /> : null}</button>; })}
        <span className="ml-1 text-xs text-muted-foreground">{selectedAccent.name}</span>
      </div>
    </Section>

    <Section title="Density" description="Choose how much operational data fits on screen.">
      <div className="w-fit rounded-full bg-secondary p-0.5">
        {(["comfortable", "compact"] as const).map((density) => <button key={density} type="button" onClick={() => setDensity(density)} aria-pressed={preferences.density === density} className={cn("rounded-full px-4 py-1.5 text-xs font-medium capitalize", preferences.density === density ? "bg-card text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")}>{density}</button>)}
      </div>
      <div className="mt-4 overflow-hidden rounded-md border border-border"><div className="flex h-8 items-center gap-3 border-b border-border bg-secondary px-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><span className="w-28">Organization</span><span>Plan</span></div>{[{ name: "Nimbus Labs", plan: "Scale" }, { name: "Ferrostack", plan: "Growth" }, { name: "Bluepine Co.", plan: "Trial" }].map((row) => <div key={row.name} className="flex items-center gap-3 border-b border-border px-3 last:border-b-0" style={{ height: preferences.density === "compact" ? 36 : 44 }}><span className="size-4 shrink-0 rounded-full bg-primary/10" /><span className="w-28 truncate text-xs text-foreground">{row.name}</span><span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{row.plan}</span></div>)}</div>
    </Section>

    <Section title="Interface" description="Fine-tune how the Admin workspace behaves.">
      <div className="divide-y divide-border">{INTERFACE_OPTIONS.map((item) => <div key={item.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div><p className="text-[13px] font-medium text-foreground">{item.title}</p><p className="text-xs text-muted-foreground">{item.description}</p></div><PreferenceSwitch checked={preferences.interface[item.key]} onChange={(value) => setInterfacePreference(item.key, value)} label={item.title} /></div>)}</div>
    </Section>

    <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 p-4"><div><p className="text-sm font-medium text-foreground">Password</p><p className="text-xs text-muted-foreground">Update your Admin account password.</p></div><Link href="/settings/password" className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground shadow-card hover:bg-accent"><KeyRound className="size-3.5" />Password settings</Link></section>
  </div>;
}
