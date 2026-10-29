import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, ArrowUp01Icon, Attachment01Icon, Calendar01Icon, Chatting01Icon, File01Icon, Globe02Icon, Menu01Icon, MoreHorizontalIcon, Plug01Icon } from "@hugeicons/core-free-icons";
import "./landing-v2-previews.css";

type DemoIcon = typeof File01Icon;
function Icon({ icon, size = 20 }: { icon: DemoIcon; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.65} aria-hidden="true" />;
}
function Preview({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return <figure className={`lv2-preview ${className}`} aria-label={label}>
    <figcaption className="lv2-preview-sr">Illustrative product preview with example information.</figcaption>
    {children}
  </figure>;
}
function Composer({ compact = false }: { compact?: boolean }) {
  return <div className={`lv2-preview-composer ${compact ? "is-compact" : ""}`} aria-hidden="true">
    <span>Type a message…</span>
    {!compact && <Icon icon={Attachment01Icon} size={16} />}
    <span className="lv2-preview-send"><Icon icon={ArrowUp01Icon} size={14} /></span>
  </div>;
}
const sources = [
  { name: "riversidestudio.co.za", detail: "Website", icon: Globe02Icon },
  { name: "Services", detail: "PDF · 12 pages", icon: File01Icon },
  { name: "Pricing", detail: "PDF · 8 pages", icon: File01Icon },
  { name: "Booking policy", detail: "PDF · 4 pages", icon: File01Icon },
];
export function KnowledgePreview() {
  return <Preview label="Example knowledge sources for Riverside Studio" className="lv2-preview-knowledge">
    <div className="lv2-preview-heading"><strong>Knowledge sources</strong><span className="lv2-preview-add" aria-hidden="true">+ <span>Add source</span></span></div>
    <div className="lv2-preview-source-list">{sources.map(source => <div className="lv2-preview-source" key={source.name}>
      <Icon icon={source.icon} size={23} />
      <div><strong>{source.name}</strong><small>{source.detail}</small></div>
      <span className="lv2-preview-ready"><i />Ready</span><Icon icon={MoreHorizontalIcon} size={17} />
    </div>)}</div>
  </Preview>;
}
export function BusinessPreview() {
  return <Preview label="An example conversation handed over from an agent to Alex" className="lv2-preview-business">
    <div className="lv2-preview-heading"><Icon icon={Chatting01Icon} size={18} /><strong>Customer conversation</strong><span className="lv2-preview-takeover" aria-hidden="true">Take over</span><Icon icon={MoreHorizontalIcon} size={16} /></div>
    <div className="lv2-preview-conversation">
      <div className="lv2-preview-message"><span className="lv2-preview-avatar">S</span><div><div className="lv2-preview-message-meta"><strong>Sarah</strong><small>10:12</small></div><p>Hi, could I speak to a person about a custom package?</p></div></div>
      <div className="lv2-preview-joined"><span className="lv2-preview-joined-icon">A</span><span>Alex joined</span><small>10:13</small></div>
      <div className="lv2-preview-message"><span className="lv2-preview-avatar is-blue">A</span><div><div className="lv2-preview-message-meta"><strong>Alex</strong><small>10:13</small></div><p>Hi Sarah! Of course, I can help with a custom package.<br />What would you like to know?</p></div></div>
    </div>
    <Composer />
  </Preview>;
}
const permissions = [
  { label: "Calendar", description: "Check availability and book appointments.", value: "Connected", icon: Calendar01Icon },
  { label: "Knowledge", description: "Use your website and documents.", value: "4 sources", icon: File01Icon },
  { label: "Instructions", description: "Tell it how to behave and what to focus on.", value: "", icon: Menu01Icon },
  { label: "Tools", description: "Give access to your business tools.", value: "Website, Calendar", icon: Plug01Icon },
];
export function AgentSettingsPreview() {
  return <Preview label="Example agent access to calendar, knowledge, instructions and tools" className="lv2-preview-access">
    {permissions.map(row => <div className="lv2-preview-permission" key={row.label}>
      <Icon icon={row.icon} size={23} /><strong>{row.label}</strong><span className="lv2-preview-permission-description">{row.description}</span>
      <span className={`lv2-preview-permission-value ${row.label === "Calendar" ? "is-connected" : ""}`}>{row.label === "Calendar" && <i />}{row.value}</span><Icon icon={ArrowRight01Icon} size={15} />
    </div>)}
  </Preview>;
}
export function ChannelIcons() {
  return <ul className="lv2-preview-channels" aria-label="Customer messaging channels">
    <li><Icon icon={Globe02Icon} size={30} /><span>Website</span></li>
    {[["whatsapp", "WhatsApp"], ["messenger", "Messenger"], ["instagram", "Instagram"], ["telegram", "Telegram"]].map(([file, label]) => <li key={file}><img src={`/images/integrations/${file}.svg`} alt="" width="30" height="30" loading="lazy" /><span>{label}</span></li>)}
  </ul>;
}
export function WebsitePreview() {
  return <Preview label="An example Riverside Studio website with an embedded agent" className="lv2-preview-website">
    <div className="lv2-preview-site-nav"><strong>Riverside Studio</strong><div><span>Home</span><span>Services</span><span>About</span><span>Contact</span><span className="lv2-preview-site-book" aria-hidden="true">Book a session</span></div></div>
    <div className="lv2-preview-site-body">
      <img className="lv2-preview-studio" src="/images/landing-v2/studio.webp" alt="" loading="lazy" />
      <div className="lv2-preview-site-copy"><h3>A space<br />for what<br />matters.</h3><p>Photography, workshops<br />and creative sessions.</p></div>
      <div className="lv2-preview-widget">
        <div className="lv2-preview-widget-heading"><span className="lv2-preview-studio-avatar">R</span><strong>Riverside Studio</strong><span aria-hidden="true">×</span></div>
        <p>Hi! I can help with bookings,<br />our services and availability.</p>
        <div className="lv2-preview-widget-question">Do you have<br />availability this week?</div>
        <Composer compact />
      </div>
    </div>
  </Preview>;
}
