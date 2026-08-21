"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  return /^#[0-9a-f]{6}$/i.test(value) ? value : DEFAULT_APPEARANCE.primaryColor;
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
        <div className="flex flex-col overflow-hidden border border-[#d8deea] bg-white shadow-[0_18px_50px_#11182730]" style={{ width: previewWidth, maxWidth: "100%", height: previewHeight, borderRadius: appearance.borderRadius }}>
          <div className="flex items-center justify-between px-4 py-[15px] text-sm font-semibold text-white" style={{ backgroundColor: primaryColor }}><span>{title}</span><X className="h-4 w-4" aria-hidden="true" /></div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-[#f8fafc] p-[14px]">
            <div className="max-w-[92%] self-start whitespace-pre-wrap rounded-xl bg-[#e7eaf2] px-3 py-2.5 text-sm leading-[1.35] text-[#172033]">{welcome}</div>
            <div className="max-w-[88%] self-end rounded-xl px-3 py-2.5 text-sm leading-[1.35] text-white" style={{ backgroundColor: primaryColor }}>What can you help with?</div>
          </div>
          <div className="border-t border-[#e2e8f0] bg-white p-2.5"><div className="flex gap-2"><div className="flex min-w-0 flex-1 items-center rounded-[9px] border border-[#cbd5e1] px-3 text-sm text-[#64748b]">Type a message…</div><div className="rounded-[9px] px-[13px] py-2.5 text-sm font-medium text-white" style={{ backgroundColor: primaryColor }}>Send</div></div></div>
          {appearance.showBranding ? <div className="bg-white px-3 pb-2.5 text-center text-xs text-[#64748b]">Powered by <a href="https://kasitek.co.za" className="hover:underline">KasiTek</a></div> : null}
        </div>
      </div>
      <div className={`mt-4 flex ${deployment.launcherPosition === "bottom-left" ? "justify-start" : "justify-end"}`}><div className="grid place-items-center rounded-full text-white shadow-[0_8px_24px_#11182740]" style={{ width: appearance.launcherSize, height: appearance.launcherSize, backgroundColor: primaryColor }}><MessageCircle className="h-6 w-6" aria-hidden="true" /></div></div>
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

  return <div className="min-h-screen px-4 py-6 sm:px-6 lg:px-8">
    <div className="mx-auto max-w-[1500px]">
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
