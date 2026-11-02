import {
  Bot,
  CalendarDays,
  Check,
  FileText,
  Inbox,
  Megaphone,
  Users,
} from "lucide-react";
import Image from "next/image";

function WhatsAppMark() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="WhatsApp">
      <path
        fill="currentColor"
        d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.18-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.91-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.28.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.23 1.36.19 1.87.12.57-.09 1.76-.72 2.01-1.42.25-.69.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35Zm-5.42 7.4h-.01a9.86 9.86 0 0 1-5.03-1.37l-.36-.22-3.74.98 1-3.65-.24-.37a9.87 9.87 0 1 1 8.38 4.63Zm8.41-18.29A11.82 11.82 0 0 0 12.05 0 11.9 11.9 0 0 0 .16 11.89c0 2.1.54 4.14 1.58 5.95L.06 24l6.3-1.65a11.9 11.9 0 0 0 5.69 1.45h.01A11.9 11.9 0 0 0 20.46 3.5Z"
      />
    </svg>
  );
}

function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Telegram">
      <path
        fill="currentColor"
        d="M11.94 0A12 12 0 1 0 24 12 12.01 12.01 0 0 0 11.94 0Zm4.97 8.22-1.98 9.3c-.14.65-.53.81-1.08.5l-3-2.21-1.45 1.4c-.16.16-.3.29-.6.29l.21-3.05 5.56-5.02c.25-.22-.05-.34-.37-.12l-6.87 4.32-2.96-.93c-.65-.2-.66-.64.13-.95l11.57-4.46c.54-.2 1.01.13.86.93Z"
      />
    </svg>
  );
}

function DiscordMark() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Discord">
      <path
        fill="currentColor"
        d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.08.08 0 0 0-.08.04c-.21.38-.44.87-.61 1.25a22.6 22.6 0 0 0-5.48 0c-.17-.39-.41-.87-.62-1.25a.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C2.62 9.05 1.26 13.58 1.67 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.1c-.66-.25-1.28-.55-1.88-.9a.08.08 0 0 1-.01-.12l.38-.3a.07.07 0 0 1 .07 0c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1-.01.13c-.6.34-1.22.64-1.87.89a.08.08 0 0 0-.04.1c.36.7.77 1.36 1.22 2a.08.08 0 0 0 .09.02 19.9 19.9 0 0 0 6-3.03.08.08 0 0 0 .03-.05c.48-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.98 0c-1.18 0-2.16-1.08-2.16-2.42s.95-2.42 2.16-2.42 2.17 1.1 2.15 2.42c0 1.34-.94 2.42-2.15 2.42Z"
      />
    </svg>
  );
}

function AgentConnections() {
  return (
    <svg
      className="agent-network-connections"
      viewBox="0 0 1000 280"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <marker
          id="agent-flow-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto"
        >
          <path d="M0 0 10 5 0 10Z" fill="#264a7a" />
        </marker>
      </defs>

      <g className="agent-connection-branches">
        <path d="M250 35 C278 35 270 140 292 140" />
        <path d="M250 105 C278 105 270 140 292 140" />
        <path d="M250 175 C278 175 270 140 292 140" />
        <path d="M250 245 C278 245 270 140 292 140" />
      </g>
      <path
        className="agent-connection-direction"
        d="M288 140 H297"
        markerEnd="url(#agent-flow-arrow)"
      />

      <path className="agent-connection-direction" d="M657 140 H674" />
      <g className="agent-connection-branches agent-connection-workspace-branches">
        <path d="M674 140 C688 140 680 47 696 47" markerEnd="url(#agent-flow-arrow)" />
        <path d="M674 140 H696" markerEnd="url(#agent-flow-arrow)" />
        <path d="M674 140 C688 140 680 233 696 233" markerEnd="url(#agent-flow-arrow)" />
      </g>
    </svg>
  );
}


const workspaceTools = [
  { label: "Conversations", detail: "Customer history", icon: Inbox, tone: "blue" },
  { label: "Contacts", detail: "Customer records", icon: Users, tone: "violet" },
  { label: "Bookings", detail: "Live availability", icon: CalendarDays, tone: "coral" },
  { label: "Campaigns", detail: "Outreach activity", icon: Megaphone, tone: "gold" },
  { label: "Multi-platform content", detail: "Drafts and posts", icon: FileText, tone: "violet" },
  { label: "Agents", detail: "Create and manage agents", icon: Bot, tone: "blue" },
];

export function AgentSystemPreview() {
  return (
    <div className="agent-network" aria-label="Agents connected system">
      <AgentConnections />

      <div className="agent-network-channels">
        <div className="agent-channel-list">
          <article className="agent-channel-card">
            <span className="agent-channel-mark agent-channel-mark-web">
              <Image src="/logo.png" width={48} height={48} alt="Kasitek web" />
            </span>
            <span><strong>Web</strong></span>
          </article>
          <article className="agent-channel-card">
            <span className="agent-channel-mark agent-channel-mark-whatsapp"><WhatsAppMark /></span>
            <span><strong>WhatsApp</strong></span>
          </article>
          <article className="agent-channel-card">
            <span className="agent-channel-mark agent-channel-mark-telegram"><TelegramMark /></span>
            <span><strong>Telegram</strong></span>
          </article>
          <article className="agent-channel-card">
            <span className="agent-channel-mark agent-channel-mark-discord"><DiscordMark /></span>
            <span><strong>Discord</strong></span>
          </article>
        </div>
      </div>

      <i className="agent-network-mobile-connection" aria-hidden="true" />

      <article className="agent-runtime-card">
        <header>
          <span className="agent-runtime-logo">
            <Image src="/logo.png" width={64} height={64} alt="" />
          </span>
          <span className="agent-runtime-name"><strong>Agents</strong></span>
          <span className="agent-runtime-state"><i /> Active</span>
        </header>

        <div className="agent-runtime-conversation">
          <p>Who should I follow up with today?</p>
          <div className="agent-runtime-action">
            <span className="agent-runtime-action-icon"><Inbox aria-hidden="true" /></span>
            <span>
              <small>Inbox and contacts checked</small>
              <strong>6 customers need a response</strong>
              <em>3 consultations · 2 pricing · 1 booking</em>
            </span>
            <Check aria-label="Completed" />
          </div>
        </div>

        <footer>
          <span>Shared context</span>
          <span>Tool access</span>
          <span>Durable state</span>
        </footer>
      </article>

      <i className="agent-network-mobile-connection" aria-hidden="true" />

      <div className="agent-network-workspace">
        <div className="agent-workspace-grid">
          {workspaceTools.map(({ label, detail, icon: Icon, tone }) => (
            <article className="agent-workspace-card" key={label}>
              <span className={`agent-workspace-icon agent-workspace-icon-${tone}`}><Icon aria-hidden="true" /></span>
              <span><strong>{label}</strong><small>{detail}</small></span>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
