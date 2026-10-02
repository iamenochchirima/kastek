"use client";

import Link from "@/lib/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowLeft, Bot, Check, LoaderCircle, Maximize2, MessageCircle, Mic, Paperclip, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  listAgentWebsiteDeployments,
  updateAgentWebsiteDeployment,
  type AgentDefinition,
  type AgentWebsiteDeployment,
} from "@/lib/agent-platform";

const COLOR_PRESETS = [
  { value: "indigo", label: "Indigo", color: "#3730a3" },
  { value: "violet", label: "Violet", color: "#7c3aed" },
  { value: "emerald", label: "Emerald", color: "#059669" },
  { value: "blue", label: "Blue", color: "#2563eb" },
  { value: "slate", label: "Slate", color: "#334155" },
] as const;

const DEFAULT_APPEARANCE: AgentWebsiteDeployment["appearance"] = {
  primaryColor: "#3730a3",
  launcherSize: 56,
  windowWidth: 390,
  windowHeight: 620,
  borderRadius: 16,
  launcherOffset: 16,
  showBranding: true,
};

function normalizedAppearance(deployment: AgentWebsiteDeployment) {
  return { ...DEFAULT_APPEARANCE, ...deployment.appearance };
}

function chatTitle(deployment: AgentWebsiteDeployment, fallback: string) {
  return deployment.displayName?.trim() || fallback;
}

function chatWelcome(deployment: AgentWebsiteDeployment, fallback: string) {
  return deployment.welcomeText?.trim() || `Hi, I’m ${fallback}. How can I help?`;
}

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeHexColor(value: string) {
  const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return DEFAULT_APPEARANCE.primaryColor;
  if (match[1].length === 6) return value;
  return `#${match[1].split("").map((character) => `${character}${character}`).join("")}`;
}

function WebsiteChatPreview({ deployment, agentName }: { deployment: AgentWebsiteDeployment; agentName: string }) {
  const appearance = normalizedAppearance(deployment);
  const title = chatTitle(deployment, agentName);
  const welcome = chatWelcome(deployment, agentName);
  const primaryColor = safeHexColor(appearance.primaryColor);
  const previewWidth = Math.min(Math.max(appearance.windowWidth, 300), 460);
  const previewHeight = Math.min(Math.max(appearance.windowHeight, 440), 700);

  return <div className="lg:sticky lg:top-6">
    <div className="rounded-2xl border border-border bg-secondary/25 p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">Live preview</p><p className="mt-1 text-xs text-muted-foreground">This is the same layout visitors see.</p></div><span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">{appearance.windowWidth} × {appearance.windowHeight}</span></div>
      <div className={`flex min-h-[720px] items-end rounded-xl border border-border bg-[radial-gradient(circle_at_top,#ffffff_0%,#e8edf5_60%,#dbe3ee_100%)] p-4 ${deployment.launcherPosition === "bottom-left" ? "justify-start" : "justify-end"}`}>
        <div className="flex flex-col overflow-hidden border border-[#d9d9d9] bg-white shadow-[0_20px_55px_#1118272e]" style={{ width: previewWidth, maxWidth: "100%", height: previewHeight, borderRadius: appearance.borderRadius }}>
          <div className="flex min-h-[72px] items-center justify-between gap-3 bg-[#1f1f1f] px-[15px] py-3.5 text-white">
            <div className="flex min-w-0 items-center gap-[11px]">
              <div className="relative h-10 w-10 shrink-0"><Avatar className="h-10 w-10 border-2 border-white bg-[#f4f4f2] text-[#1f1f1f]"><AvatarImage src={deployment.avatarUrl ?? undefined} alt="" /><AvatarFallback className="bg-[#f4f4f2] text-[#1f1f1f]"><Bot className="h-6 w-6" strokeWidth={1.5} aria-hidden="true" /></AvatarFallback></Avatar><span className="absolute -bottom-px -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#1f1f1f]" style={{ backgroundColor: primaryColor }} /></div>
              <div className="flex min-w-0 flex-col gap-0.5"><strong className="max-w-[210px] truncate text-[15px] leading-tight">{title}</strong><span className="text-[11px] font-medium leading-tight text-[#bdbdbd]">Powered by AI</span></div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5 text-[#d1d1d1]"><Maximize2 className="h-[19px] w-[19px]" aria-hidden="true" /><X className="h-[19px] w-[19px]" aria-hidden="true" /></div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-white px-[15px] py-4">
            <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-[5px_16px_16px_16px] bg-[#f3f1f0] px-[13px] py-2.5 text-[13.5px] leading-[1.42] text-[#292929]">{welcome}</div>
            <div className="flex max-w-full flex-wrap gap-1.5 px-px pb-0.5"><span className="rounded-full border border-[#d0d0d0] bg-white px-2.5 py-[7px] text-[12px] leading-tight text-[#3a3a3a]">What can you help with?</span><span className="rounded-full border border-[#d0d0d0] bg-white px-2.5 py-[7px] text-[12px] leading-tight text-[#3a3a3a]">How does this work?</span><span className="rounded-full border border-[#d0d0d0] bg-white px-2.5 py-[7px] text-[12px] leading-tight text-[#3a3a3a]">Talk to a person</span></div>
          </div>
          <div className="border-t border-[#eeeeee] bg-white px-3 py-2.5"><div className="flex min-h-[46px] items-center gap-0.5 rounded-full border border-[#bdbdbd] bg-white px-[5px] pl-[11px]"><Mic className="mx-1 h-[18px] w-[18px] shrink-0 text-[#8b8b8b]" aria-hidden="true" /><div className="min-w-0 flex-1 px-1.5 py-2 text-[13.5px] text-[#848484]">Ask me anything...</div><Paperclip className="h-[18px] w-[18px] shrink-0 text-[#8b8b8b]" aria-hidden="true" /><div className="ml-0.5 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-white" style={{ backgroundColor: primaryColor }}><Send className="h-[17px] w-[17px]" aria-hidden="true" /></div></div></div>
          <div className="bg-white px-3 pb-[11px] text-center text-[11px] leading-[1.35] text-[#8c8c8c]">AI-generated content may be inaccurate.{appearance.showBranding ? <> · <a href="https://kasitek.co.za" className="font-semibold underline decoration-1 underline-offset-2" style={{ color: primaryColor }}>Powered by KasiTek</a></> : null}</div>
        </div>
      </div>
      <div className={`mt-4 flex ${deployment.launcherPosition === "bottom-left" ? "justify-start" : "justify-end"}`}><div className="grid place-items-center rounded-full border border-white/70 text-white shadow-[0_10px_28px_#11182745,0_0_0_5px_var(--launcher-ring)]" style={{ width: appearance.launcherSize, height: appearance.launcherSize, backgroundColor: primaryColor, "--launcher-ring": `${primaryColor}1a` } as CSSProperties}><MessageCircle className="h-6 w-6" aria-hidden="true" /></div></div>
    </div>
  </div>;
}

export function AgentWebsiteChatAppearancePageClient({ agent }: { agent: AgentDefinition }) {
  const [deployments, setDeployments] = useState<AgentWebsiteDeployment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<AgentWebsiteDeployment | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const installationId = agent.installation_id;

  const activeDeployments = useMemo(() => deployments.filter((deployment) => deployment.status !== "REVOKED"), [deployments]);

  const load = useCallback(async () => {
    if (!installationId) return;
    setLoading(true);
    try {
      const result = await listAgentWebsiteDeployments(installationId);
      const available = result.deployments.filter((deployment) => deployment.status !== "REVOKED");
      setDeployments(result.deployments);
      const selected = available.find((deployment) => deployment.id === selectedId) ?? available[0] ?? null;
      setSelectedId(selected?.id ?? "");
      setDraft(selected ? { ...selected, appearance: normalizedAppearance(selected) } : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Website Chat appearance.");
    } finally {
      setLoading(false);
    }
  }, [installationId, selectedId]);

  useEffect(() => { void load(); }, [load]);

  const selectDeployment = (id: string) => {
    const deployment = activeDeployments.find((item) => item.id === id);
    if (!deployment) return;
    setSelectedId(id);
    setDraft({ ...deployment, appearance: normalizedAppearance(deployment) });
    setNotice(null);
  };

  const updateDraft = (changes: Partial<AgentWebsiteDeployment>) => setDraft((current) => current ? { ...current, ...changes } : current);
  const updateAppearance = (changes: Partial<AgentWebsiteDeployment["appearance"]>) => setDraft((current) => current ? { ...current, appearance: { ...normalizedAppearance(current), ...changes } } : current);

  const choosePreset = (preset: typeof COLOR_PRESETS[number]) => {
    updateDraft({ colorPreset: preset.value });
    updateAppearance({ primaryColor: preset.color });
  };

  const save = async () => {
    if (!draft || !installationId || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await updateAgentWebsiteDeployment(installationId, draft.id, {
        displayName: draft.displayName?.trim() || agent.name,
        welcomeText: draft.welcomeText?.trim() || `Hi, I’m ${agent.name}. How can I help?`,
        launcherPosition: draft.launcherPosition,
        colorPreset: draft.colorPreset,
        appearance: normalizedAppearance(draft),
      });
      setDeployments((current) => current.map((deployment) => deployment.id === draft.id ? result.deployment : deployment));
      setDraft({ ...result.deployment, appearance: normalizedAppearance(result.deployment) });
      setNotice("Appearance saved. The widget will use these settings for new page loads.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Website Chat appearance.");
    } finally {
      setSaving(false);
    }
  };

  const appearance = draft ? normalizedAppearance(draft) : DEFAULT_APPEARANCE;

  return <div className="min-h-[100dvh] px-4 py-6 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1440px]">
      <Link href={`/agents/${encodeURIComponent(agent.id)}`} className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to {agent.name}</Link>
      <PageHeader className="mt-5 border-b border-border pb-5"><PageHeaderContent><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Website Chat</p><PageHeaderTitle>Appearance</PageHeaderTitle><PageHeaderDescription>Style the visitor chat window.</PageHeaderDescription></PageHeaderContent>{draft ? <PageHeaderActions><Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save changes"}</Button></PageHeaderActions> : null}</PageHeader>

      {error ? <p className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
      {notice ? <p className="mt-5 flex items-center gap-2 rounded-xl border border-status-success/30 bg-status-success-soft px-4 py-3 text-sm text-status-success" role="status"><Check className="h-4 w-4" />{notice}</p> : null}

      {loading ? <div className="mt-8 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Loading Website Chat…</div> : !draft ? <Card className="mt-6"><CardContent className="p-6"><h2 className="text-lg font-semibold text-foreground">No Website Chat is configured</h2><p className="mt-2 text-sm text-muted-foreground">Add an approved website in Integrations before choosing its appearance.</p><Button asChild className="mt-4"><Link href={`/agents/${encodeURIComponent(agent.id)}?section=integrations`}>Open Integrations</Link></Button></CardContent></Card> : <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(390px,0.85fr)]">
        <div className="space-y-5">
          {activeDeployments.length > 1 ? <Card><CardContent className="p-5"><label className="block text-sm font-medium text-foreground">Website deployment<Select value={selectedId} onValueChange={selectDeployment}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent>{activeDeployments.map((deployment) => <SelectItem key={deployment.id} value={deployment.id}>{deployment.allowedOrigins.join(", ") || deployment.publicId}</SelectItem>)}</SelectContent></Select></label></CardContent></Card> : null}

          <Card><CardContent className="space-y-5 p-5 sm:p-6"><div><h2 className="text-lg font-semibold text-foreground">Chat content</h2><p className="mt-1 text-sm text-muted-foreground">The text visitors see when the chat opens.</p></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Title<Input value={draft.displayName ?? ""} maxLength={100} onChange={(event) => updateDraft({ displayName: event.target.value })} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Chat position<Select value={draft.launcherPosition} onValueChange={(value) => updateDraft({ launcherPosition: value as AgentWebsiteDeployment["launcherPosition"] })}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bottom-right">Bottom right</SelectItem><SelectItem value="bottom-left">Bottom left</SelectItem></SelectContent></Select></label></div><label className="block text-sm font-medium text-foreground">Welcome message<Textarea value={draft.welcomeText ?? ""} rows={3} maxLength={500} onChange={(event) => updateDraft({ welcomeText: event.target.value })} className="mt-2 resize-y" /></label></CardContent></Card>

          <Card><CardContent className="space-y-5 p-5 sm:p-6"><div><h2 className="text-lg font-semibold text-foreground">Colours</h2><p className="mt-1 text-sm text-muted-foreground">Choose a starting theme or use your exact brand colour.</p></div><div className="flex flex-wrap gap-3">{COLOR_PRESETS.map((preset) => <button key={preset.value} type="button" aria-label={`${preset.label} theme`} title={preset.label} onClick={() => choosePreset(preset)} className={`grid h-11 w-11 place-items-center rounded-full border-2 transition-transform hover:scale-105 ${draft.colorPreset === preset.value ? "border-foreground" : "border-transparent"}`} style={{ backgroundColor: preset.color }}>{draft.colorPreset === preset.value ? <Check className="h-4 w-4 text-white" /> : null}</button>)}</div><div className="grid gap-4 sm:grid-cols-[1fr_150px]"><label className="text-sm font-medium text-foreground">Primary colour<Input value={appearance.primaryColor} onChange={(event) => updateAppearance({ primaryColor: event.target.value })} pattern="#[0-9A-Fa-f]{6}" className="mt-2 font-mono" /></label><label className="text-sm font-medium text-foreground">Pick colour<Input type="color" value={safeHexColor(appearance.primaryColor)} onChange={(event) => updateAppearance({ primaryColor: event.target.value })} className="mt-2 p-1" /></label></div></CardContent></Card>

          <Card><CardContent className="space-y-5 p-5 sm:p-6"><div><h2 className="text-lg font-semibold text-foreground">Window and launcher</h2><p className="mt-1 text-sm text-muted-foreground">Set the size and spacing of the real Website Chat widget.</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><label className="text-sm font-medium text-foreground">Chat width<Input type="number" min={300} max={600} value={appearance.windowWidth} onChange={(event) => updateAppearance({ windowWidth: numberValue(event.target.value, appearance.windowWidth) })} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Chat height<Input type="number" min={360} max={800} value={appearance.windowHeight} onChange={(event) => updateAppearance({ windowHeight: numberValue(event.target.value, appearance.windowHeight) })} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Corner radius<Input type="number" min={0} max={28} value={appearance.borderRadius} onChange={(event) => updateAppearance({ borderRadius: numberValue(event.target.value, appearance.borderRadius) })} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Launcher size<Input type="number" min={44} max={96} value={appearance.launcherSize} onChange={(event) => updateAppearance({ launcherSize: numberValue(event.target.value, appearance.launcherSize) })} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Screen offset<Input type="number" min={8} max={48} value={appearance.launcherOffset} onChange={(event) => updateAppearance({ launcherOffset: numberValue(event.target.value, appearance.launcherOffset) })} className="mt-2" /></label></div><label className="flex items-center gap-3 rounded-xl border border-border bg-secondary/30 px-4 py-3 text-sm text-foreground"><Checkbox checked={appearance.showBranding} onCheckedChange={(checked) => updateAppearance({ showBranding: checked === true })} />Show “Powered by KasiTek”</label></CardContent></Card>

          <div className="flex justify-end"><Button type="button" onClick={() => void save()} disabled={saving}>{saving ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Saving…</> : "Save changes"}</Button></div>
        </div>
        <WebsiteChatPreview deployment={draft} agentName={agent.name} />
      </div>}
    </div>
  </div>;
}
