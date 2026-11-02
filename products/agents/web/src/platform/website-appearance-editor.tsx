import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WebsiteAppearancePreview, websiteAppearanceDefaults, safeAvatarUrl, type WebsiteAppearance } from "./website-appearance-preview";

const presets = [["#3730a3", "Indigo"], ["#7c3aed", "Violet"], ["#059669", "Emerald"], ["#2563eb", "Blue"], ["#334155", "Slate"]];
const dimensions = [
  ["windowWidth", "Window width", 300, 600], ["windowHeight", "Window height", 360, 800],
  ["borderRadius", "Corner radius", 0, 28], ["launcherSize", "Launcher size", 44, 96],
  ["launcherOffset", "Screen offset", 8, 48],
] as const;
export function WebsiteAppearanceEditor({ appearance, owner, onSave }: { appearance: WebsiteAppearance; owner: boolean; onSave: (value: WebsiteAppearance) => Promise<void> }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState({ ...websiteAppearanceDefaults, ...appearance });
  const [replies, setReplies] = useState(appearance.quickReplies.join("\n"));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  function change(patch: Partial<typeof draft>) { setDraft(current => ({ ...current, ...patch })); }
  function begin() { setDraft({ ...websiteAppearanceDefaults, ...appearance }); setReplies(appearance.quickReplies.join("\n")); setError(""); setOpen(true); }
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!safeAvatarUrl(draft.avatarUrl)) { setError("Use an HTTPS image URL."); return; }
    const quickReplies = replies.split("\n").map(value => value.trim()).filter(Boolean);
    if (quickReplies.length > 5) { setError("Enter up to five suggested messages."); return; }
    setBusy(true);
    try { await onSave({ ...draft, avatarUrl: draft.avatarUrl.trim(), quickReplies }); setOpen(false); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save appearance"); } finally { setBusy(false); }
  }
  const disabled = !owner || busy;
  return <><Button type="button" variant="outline" onClick={begin}>{owner ? "Customize widget" : "View appearance"}</Button><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent className="sm:max-w-[min(72rem,calc(100vw-2rem))]" aria-describedby={undefined}><DialogHeader><DialogTitle>Widget appearance</DialogTitle></DialogHeader>
    <form onSubmit={save} className="min-w-0 space-y-5"><div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><div className="min-w-0 space-y-5">
      <label className="block space-y-2 text-sm"><span>Chat title</span><Input required maxLength={80} value={draft.title} disabled={disabled} onChange={event => change({ title: event.target.value })} /></label>
      <label className="block space-y-2 text-sm"><span>Greeting</span><Textarea maxLength={240} value={draft.greeting} disabled={disabled} onChange={event => change({ greeting: event.target.value })} /></label>
      <label className="block space-y-2 text-sm"><span>Avatar URL</span><Input type="url" value={draft.avatarUrl} disabled={disabled} placeholder="https://example.com/avatar.png" onChange={event => change({ avatarUrl: event.target.value })} aria-invalid={!!draft.avatarUrl && !safeAvatarUrl(draft.avatarUrl)} />{draft.avatarUrl && !safeAvatarUrl(draft.avatarUrl) ? <span className="text-xs text-destructive">Use an HTTPS image URL.</span> : null}</label>
      <fieldset className="space-y-3"><legend className="text-sm">Brand colour</legend><div className="flex flex-wrap gap-2">{presets.map(([accent, label]) => <button type="button" key={accent} disabled={disabled} aria-label={label} aria-pressed={draft.accent === accent} onClick={() => change({ accent })} className="grid size-10 place-items-center rounded-full border-2 border-transparent text-white outline-offset-2 aria-pressed:border-foreground disabled:opacity-50" style={{ backgroundColor: accent }}>{draft.accent === accent ? <span aria-hidden="true">✓</span> : null}</button>)}</div><div className="flex gap-2"><label className="flex shrink-0 items-center gap-2 text-sm"><span>Custom</span><input type="color" aria-label="Custom colour" value={/^#[0-9a-f]{6}$/i.test(draft.accent) ? draft.accent : "#3730a3"} disabled={disabled} onChange={event => change({ accent: event.target.value })} className="size-10 rounded border border-border bg-background p-1" /></label><Input aria-label="Colour hex code" pattern="#[0-9a-fA-F]{6}" required value={draft.accent} disabled={disabled} onChange={event => change({ accent: event.target.value })} /></div></fieldset>
      <div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-sm"><span>Launcher label</span><Input required maxLength={32} value={draft.launcherLabel} disabled={disabled} onChange={event => change({ launcherLabel: event.target.value })} /></label><label className="space-y-2 text-sm"><span>Position</span><select aria-label="Position" value={draft.position} disabled={disabled} className="w-full rounded-md border border-border bg-background p-2" onChange={event => change({ position: event.target.value as WebsiteAppearance["position"] })}><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></select></label></div>
      <fieldset className="grid gap-4 sm:grid-cols-2"><legend className="mb-3 text-sm font-medium">Size and spacing</legend>{dimensions.map(([key, label, min, max]) => <label key={key} className="space-y-2 text-sm"><span>{label} <span className="text-muted-foreground">(px)</span></span><Input type="number" min={min} max={max} required value={draft[key]} disabled={disabled} onChange={event => change({ [key]: Number(event.target.value) })} /></label>)}</fieldset>
      <label className="block space-y-2 text-sm"><span>Suggested messages</span><Textarea aria-label="Suggested messages" value={replies} rows={3} maxLength={1000} disabled={disabled} onChange={event => setReplies(event.target.value)} /><span className="text-xs text-muted-foreground">Up to five, one per line.</span></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.showBranding} disabled={disabled} onChange={event => change({ showBranding: event.target.checked })} />Show KasiTek branding</label>
    </div><WebsiteAppearancePreview appearance={{ ...draft, quickReplies: replies.split("\n").filter(Boolean).slice(0, 5) }} /></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{owner ? "Cancel" : "Close"}</Button>{owner ? <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button> : null}</DialogFooter></form>
  </DialogContent></Dialog></>;
}
