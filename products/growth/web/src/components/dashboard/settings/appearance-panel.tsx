"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ACCENTS, setAccent, setDensity, setInterfacePreference, setTheme, useAppearance, type AccentTokens, type ThemeMode } from "@/lib/appearance";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  settingsCardVariants,
  settingsModeVariants,
  VANTAGE_DENSITY_TRANSITION,
  VANTAGE_MOTION,
  VANTAGE_SELECTION_SPRING,
} from "@/lib/motion";

type PreviewTokens = {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  ink: string;
  ink3: string;
  accent: AccentTokens;
};

const LIGHT: PreviewTokens = {
  bg: "#F6F7F9",
  surface: "#FFFFFF",
  surface2: "#F0F2F5",
  border: "#E4E7ED",
  ink: "#0B1020",
  ink3: "#8B94AB",
  accent: ACCENTS[0].light,
};

const DARK: PreviewTokens = {
  bg: "#090B11",
  surface: "#10131C",
  surface2: "#171B28",
  border: "#1E2432",
  ink: "#F3F5F9",
  ink3: "#5E6880",
  accent: ACCENTS[0].dark,
};

const CHART_LINE = "M0 22 L15 18 L30 20 L45 12 L60 15 L75 8 L90 11 L105 5 L120 8";

function MiniDashboard({ tokens }: { tokens: PreviewTokens }) {
  return (
    <div className="flex h-full w-full" style={{ background: tokens.bg }}>
      <div className="flex w-6 shrink-0 flex-col items-center gap-1.5 border-r py-2" style={{ borderColor: tokens.border, background: tokens.surface }}>
        <div className="h-2.5 w-2.5 rounded-[3px]" style={{ background: tokens.accent.base }} />
        {[0, 1, 2].map((item) => <div key={item} className="h-1.5 w-3 rounded-full" style={{ background: item === 0 ? tokens.accent.base : tokens.surface2 }} />)}
      </div>
      <div className="min-w-0 flex-1 p-2">
        <div className="h-1.5 w-10 rounded-full" style={{ background: tokens.ink3, opacity: 0.55 }} />
        <div className="mt-1.5 grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map((item) => (
            <div key={item} className="rounded-[4px] border p-1" style={{ background: tokens.surface, borderColor: tokens.border }}>
              <div className="h-1 w-4 rounded-full" style={{ background: tokens.ink3, opacity: 0.5 }} />
              <div className="mt-1 h-1.5 w-5 rounded-full" style={{ background: tokens.ink, opacity: 0.85 }} />
            </div>
          ))}
        </div>
        <div className="mt-1.5 rounded-[4px] border p-1" style={{ background: tokens.surface, borderColor: tokens.border }}>
          <svg viewBox="0 0 120 28" className="block h-7 w-full" preserveAspectRatio="none" aria-hidden="true">
            <path d={`${CHART_LINE} L120 28 L0 28 Z`} fill={tokens.accent.base} opacity={0.14} stroke="none" />
            <path d={CHART_LINE} fill="none" stroke={tokens.accent.base} strokeWidth={2} strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

const MODES: ReadonlyArray<{ id: ThemeMode; label: string; caption: string; icon: typeof Sun }> = [
  { id: "light", label: "Light", caption: "Crisp and bright", icon: Sun },
  { id: "dark", label: "Dark", caption: "Easy on the eyes", icon: Moon },
  { id: "system", label: "System", caption: "Follows your OS", icon: Monitor },
];

function SectionCard({ title, description, children, index = 0 }: { title: string; description?: string; children: React.ReactNode; index?: number }) {
  return (
    <motion.section
      variants={settingsCardVariants(index)}
      initial="hidden"
      animate="visible"
      className="v-settings-card rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]"
    >
      <h2 className="text-base font-semibold leading-6 tracking-[-0.01em] text-foreground">{title}</h2>
      {description ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </motion.section>
  );
}

function ModeCard({ mode, selected, accent, index }: { mode: (typeof MODES)[number]; selected: boolean; accent: typeof ACCENTS[number]; index: number }) {
  const Icon = mode.icon;
  const lightPreview = { ...LIGHT, accent: accent.light };
  const darkPreview = { ...DARK, accent: accent.dark };
  return (
    <motion.button
      type="button"
      variants={settingsModeVariants(index)}
      initial="hidden"
      animate="visible"
      whileTap={{ scale: 0.98 }}
      onClick={() => setTheme(mode.id)}
      aria-pressed={selected}
      className="group w-[180px] max-w-full text-left"
    >
      <div className={cn("relative h-[110px] overflow-hidden rounded-md border transition-[border-color,box-shadow] duration-200", selected ? "border-transparent shadow-[0_0_0_2px_var(--appearance-accent)]" : "border-border group-hover:border-border/80")}>
        {mode.id === "system" ? (
          <div className="flex h-full">
            <div className="h-full w-1/2 overflow-hidden border-r" style={{ borderColor: DARK.border }}><MiniDashboard tokens={lightPreview} /></div>
            <div className="h-full w-1/2 overflow-hidden"><MiniDashboard tokens={darkPreview} /></div>
          </div>
        ) : <MiniDashboard tokens={mode.id === "light" ? lightPreview : darkPreview} />}
        <AnimatePresence>
          {selected ? (
            <motion.span
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={VANTAGE_SELECTION_SPRING}
              className="absolute right-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-[var(--shadow-floating)]"
            >
              <Check size={12} strokeWidth={3} />
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Icon size={14} className={selected ? "text-primary" : "text-muted-foreground"} />
        <span className={cn("text-[13px] font-medium", selected ? "text-foreground" : "text-muted-foreground")}>{mode.label}</span>
        <span className="text-[11px] text-muted-foreground">· {mode.caption}</span>
      </div>
    </motion.button>
  );
}

const INTERFACE_SWITCHES: ReadonlyArray<{ key: "reduceMotion" | "liveIndicators" | "weekStartsMonday"; title: string; description: string }> = [
  { key: "reduceMotion", title: "Reduce motion", description: "Minimises animations and live pulses app-wide." },
  { key: "liveIndicators", title: "Show live indicators", description: "Pulsing dots on real-time tiles and feeds." },
  { key: "weekStartsMonday", title: "Week starts on Monday", description: "Used by calendars and weekly reports." },
];

export function AppearancePanel() {
  const preferences = useAppearance();
  const selectedAccent = ACCENTS.find((accent) => accent.id === preferences.accent) ?? ACCENTS[0];

  return (
    <MotionConfig reducedMotion={preferences.interface.reduceMotion ? "always" : "user"}>
      <div className="flex flex-col gap-5">
      <SectionCard title="Theme" description="Instantly re-themes the entire app — try it." index={0}>
        <div className="flex flex-wrap gap-4">
          {MODES.map((mode, index) => <ModeCard key={mode.id} mode={mode} selected={preferences.theme === mode.id} accent={selectedAccent} index={index} />)}
        </div>
      </SectionCard>

      <SectionCard title="Accent color" description="Re-skins buttons, charts and active states live." index={1}>
        <div className="flex flex-wrap items-center gap-3">
          {ACCENTS.map((accent) => {
            const selected = accent.id === preferences.accent;
            return (
              <motion.button key={accent.id} type="button" title={accent.name} aria-label={`${accent.name} accent`} aria-pressed={selected} onClick={() => setAccent(accent.id)} whileTap={{ scale: 0.9 }} animate={selected ? { scale: [1.15, 1] } : { scale: 1 }} transition={{ duration: VANTAGE_MOTION.fast / 1000 }} className="relative grid size-7 place-items-center rounded-full" style={{ backgroundColor: accent.swatch }}>
                {selected ? <><span className="absolute -inset-1 rounded-full border-2" style={{ borderColor: accent.swatch }} /><Check size={13} strokeWidth={3.5} className="relative text-white drop-shadow" /></> : null}
              </motion.button>
            );
          })}
          <span className="ml-1 text-xs capitalize text-muted-foreground">{ACCENTS.find((accent) => accent.id === preferences.accent)?.name}</span>
        </div>
      </SectionCard>

      <SectionCard title="Density" description="How much data fits on a screen." index={2}>
        <div className="w-fit rounded-full bg-secondary p-0.5">
          {(["comfortable", "compact"] as const).map((density) => {
            const active = density === preferences.density;
            return <button key={density} type="button" onClick={() => setDensity(density)} aria-pressed={active} className={cn("relative rounded-full px-3.5 py-1.5 text-xs font-medium capitalize transition-colors", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {active ? <motion.span layoutId="density-thumb" transition={VANTAGE_SELECTION_SPRING} className="absolute inset-0 rounded-full border border-border bg-card shadow-[var(--shadow-panel)]" /> : null}
              <span className="relative z-10">{density}</span>
            </button>;
          })}
        </div>
        <div className="mt-3 overflow-hidden rounded-md border border-border">
          <div className="flex h-8 items-center gap-3 border-b border-border bg-secondary px-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"><span className="w-24">Customer</span><span>Plan</span></div>
          {[{ name: "Nimbus Labs", plan: "Scale" }, { name: "Ferrostack", plan: "Growth" }, { name: "Bluepine Co.", plan: "Trial" }].map((row) => <motion.div key={row.name} animate={{ height: preferences.density === "compact" ? 36 : 44 }} transition={VANTAGE_DENSITY_TRANSITION} className="flex items-center gap-3 border-b border-border px-3 last:border-b-0"><span className="size-4 shrink-0 rounded-full bg-primary/10" /><span className="w-24 truncate text-xs text-foreground">{row.name}</span><span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">{row.plan}</span></motion.div>)}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">Compact trims table rows 44→36px and card padding 20→14px across the app.</p>
      </SectionCard>

      <SectionCard title="Interface" description="Fine-tune how the app behaves." index={3}>
        <div className="flex flex-col divide-y divide-border">
          {INTERFACE_SWITCHES.map((item) => <div key={item.key} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><div><div className="text-[13px] font-medium text-foreground">{item.title}</div><div className="text-xs text-muted-foreground">{item.description}</div></div><Switch checked={preferences.interface[item.key]} onCheckedChange={(value) => setInterfacePreference(item.key, value)} aria-label={item.title} /></div>)}
        </div>
      </SectionCard>
      </div>
    </MotionConfig>
  );
}
