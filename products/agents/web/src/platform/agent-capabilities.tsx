import { PiCalendarBlank as CalendarDays, PiChatCircle as MessageCircle, PiHeadphones as Headphones, PiUserPlus as UserRoundPlus } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import type { Agent, Configuration } from "./api";

export type CapabilityId = "answer-questions" | "customer-support" | "bookings" | "enquiries";
const capabilities = [
  { id: "answer-questions", label: "Answer questions", detail: "Answers from approved knowledge and business information.", icon: MessageCircle, configure: "knowledge" },
  { id: "customer-support", label: "Handle support", detail: "Handles requests and hands conversations to a person.", icon: Headphones, configure: "behaviour" },
  { id: "bookings", label: "Book appointments", detail: "Checks availability and records appointment requests.", icon: CalendarDays, configure: "capabilities" },
  { id: "enquiries", label: "Collect enquiries", detail: "Captures customer details and service requests.", icon: UserRoundPlus, configure: "capabilities" },
] as const;

export function AgentCapabilities({ agent, configuration, knowledgeCount, busy, onToggle, onConfigure }: {
  agent: Agent; configuration: Configuration; knowledgeCount: number; busy: boolean;
  onToggle: (id: CapabilityId, enabled: boolean) => void; onConfigure: (id: CapabilityId) => void;
}) {
  const responsibilities = agent.setup?.responsibilities ?? [];
  const enabled = (id: CapabilityId) => responsibilities.includes(id);
  const status = (id: CapabilityId) => {
    if (!enabled(id)) return "Off";
    if (id === "answer-questions") return knowledgeCount ? `${knowledgeCount} knowledge source${knowledgeCount === 1 ? "" : "s"}` : "Add knowledge";
    if (id === "customer-support") return configuration.supportHours ? "Handoff ready" : "Set support hours";
    if (id === "bookings") return configuration.capabilities.businessActions.enabled ? "Calendar connected" : "Connect calendar";
    return configuration.capabilities.enquiries?.enabled ? `Collects ${configuration.capabilities.enquiries.fields.join(", ")}` : "Needs setup";
  };
  return <section className="agent-section agent-capabilities-page">
    <header className="agent-section-heading"><div><h1>Capabilities</h1><p>What this agent can do.</p></div></header>
    <div className="agent-capability-grid">{capabilities.map(({ id, label, detail, icon: Icon }) => {
      const isEnabled = enabled(id), onlyOne = isEnabled && responsibilities.length <= 1;
      return <article className={`agent-capability-card ${isEnabled ? "is-enabled" : ""}`} key={id}>
        <span className="agent-capability-icon"><Icon size={20} /></span>
        <div className="agent-capability-main"><h2>{label}</h2><p>{detail}</p><span className="agent-capability-status" data-state={isEnabled ? "on" : "off"}>{status(id)}</span></div>
        <div className="agent-capability-actions">
          {isEnabled ? <Button size="sm" variant="outline" onClick={() => onConfigure(id)}>Configure</Button> : null}
          <Button size="sm" variant={isEnabled ? "ghost" : "outline"} disabled={busy || onlyOne} title={onlyOne ? "Keep at least one capability" : undefined} onClick={() => onToggle(id, !isEnabled)}>{isEnabled ? "Remove" : "Add"}</Button>
        </div>
      </article>;
    })}</div>
  </section>;
}
