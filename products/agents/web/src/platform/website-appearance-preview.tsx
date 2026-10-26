import { Bot, Maximize2, MessageCircle, Send, X } from "lucide-react";

export type WebsiteAppearance = {
  accent: string; title: string; greeting: string; launcherLabel: string;
  position: "bottom-right" | "bottom-left"; quickReplies: string[];
  launcherSize?: number; windowWidth?: number; windowHeight?: number;
  borderRadius?: number; launcherOffset?: number; showBranding?: boolean; avatarUrl?: string;
};
export const websiteAppearanceDefaults = {
  launcherSize: 56, windowWidth: 390, windowHeight: 620, borderRadius: 16,
  launcherOffset: 16, showBranding: true, avatarUrl: "",
};
export function safeAvatarUrl(value: string) {
  if (!value.trim()) return true;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))); } catch { return false; }
}
export function WebsiteAppearancePreview({ appearance }: { appearance: WebsiteAppearance }) {
  const value = { ...websiteAppearanceDefaults, ...appearance };
  const accent = /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent : "#3730a3";
  return <section className="min-w-0 space-y-3" aria-label="Widget preview">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><h3 className="font-medium">Live preview</h3><span className="text-xs text-muted-foreground">{value.windowWidth} × {value.windowHeight}</span></div>
    <div className="overflow-hidden rounded-xl border border-border bg-muted/40" style={{ padding: value.launcherOffset }}>
      <div className={`flex min-w-0 flex-col gap-4 ${value.position === "bottom-left" ? "items-start" : "items-end"}`}>
        <div className="flex max-w-full shrink-0 flex-col overflow-hidden border border-[#d9d9d9] bg-white text-[#292929] shadow-lg" style={{ width: value.windowWidth, height: value.windowHeight, borderRadius: value.borderRadius }}>
          <div className="flex shrink-0 items-center justify-between gap-3 bg-[#1f1f1f] px-4 py-3.5 text-white">
            <div className="flex min-w-0 items-center gap-3"><div className="relative grid size-10 shrink-0 place-items-center rounded-full border-2 border-white bg-[#f4f4f2] text-[#1f1f1f]"><Bot className="size-6" aria-hidden="true" />{value.avatarUrl && safeAvatarUrl(value.avatarUrl) ? <img key={value.avatarUrl} src={value.avatarUrl} alt="" className="absolute inset-0 size-full rounded-full object-cover" onError={event => { event.currentTarget.style.visibility = "hidden"; }} /> : null}<span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[#1f1f1f]" style={{ backgroundColor: accent }} /></div><div className="min-w-0"><strong className="block truncate text-[15px]">{value.title}</strong><span className="text-[11px] text-[#bdbdbd]">Powered by AI</span></div></div><div className="flex shrink-0 gap-2 text-[#d1d1d1]" aria-hidden="true"><Maximize2 className="size-4" /><X className="size-4" /></div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"><div className="max-w-[92%] self-start whitespace-pre-wrap break-words rounded-[5px_16px_16px_16px] bg-[#f3f1f0] px-3 py-2.5 text-[13.5px] leading-relaxed">{value.greeting}</div><div className="flex flex-wrap gap-1.5">{value.quickReplies.filter(Boolean).map((reply, index) => <span key={index} className="max-w-full break-words rounded-full border border-[#d0d0d0] px-2.5 py-2 text-xs">{reply}</span>)}</div></div>
          <div className="shrink-0 border-t border-[#eee] px-3 py-2.5"><div className="flex min-h-11 items-center gap-2 rounded-full border border-[#bdbdbd] py-1 pl-4 pr-1"><span className="min-w-0 flex-1 text-[13px] text-[#848484]">Ask me anything...</span><span className="grid size-9 shrink-0 place-items-center rounded-full text-white" style={{ backgroundColor: accent }}><Send className="size-4" aria-hidden="true" /></span></div></div>
          {value.showBranding ? <div className="shrink-0 px-3 pb-3 text-center text-[11px] text-[#777]">Powered by <span className="font-semibold" style={{ color: accent }}>KasiTek</span></div> : null}
        </div>
        <div className="grid max-w-full shrink-0 place-items-center rounded-full text-white shadow-lg" aria-label={value.launcherLabel} style={{ width: value.launcherSize, height: value.launcherSize, backgroundColor: accent }}><MessageCircle className="size-6" aria-hidden="true" /></div>
      </div>
    </div>
  </section>;
}
