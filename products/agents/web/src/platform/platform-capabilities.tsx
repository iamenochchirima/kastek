import { Button } from "@/components/ui/button";
import type { Configuration } from "./api";

type Destination = "knowledge" | "general" | "tools" | "skills";

export function PlatformCapabilities({ configuration, onConfigure }: {
  configuration: Configuration;
  onConfigure: (destination: Destination) => void;
}) {
  const selectedTools = configuration.connectedToolBindingIds?.length ?? 0;
  const knowledge = configuration.sourceRevisionIds?.length ?? 0;
  const skills = configuration.skillIds?.length ?? 0;
  const workflows = configuration.procedures?.length ?? 0;
  const delegation = configuration.capabilities.delegation;
  const handoff = configuration.tools?.some(tool => ["channel.request_handoff", "support.request_handoff", "support.request_handoff_v2"].includes(tool));
  const cards: Array<{ name: string; status: string; destination?: Destination; note?: string }> = [
    { name: "Tools", status: selectedTools ? `${selectedTools} connected` : "No connected tools", destination: "tools" },
    { name: "Knowledge", status: knowledge ? `${knowledge} sources selected` : "No sources selected", destination: "knowledge" },
    { name: "Memory", status: configuration.memory?.enabled ? "On" : "Off", destination: "general" },
    { name: "Human handoff", status: handoff ? "Tool assigned" : "No handoff tool assigned", destination: "tools" },
    { name: "Delegation", status: delegation.enabled ? `${delegation.bindings.length} agents assigned` : "Off", destination: "general" },
    { name: "Workflows", status: workflows ? `${workflows} selected` : "None selected", destination: "tools" },
    { name: "Skills", status: skills ? `${skills} selected` : "None selected", destination: "skills" },
    { name: "Schedules", status: "Unavailable" },
    { name: "Code execution", status: "Unavailable", note: "Python analysis is configured in Behaviour." },
    { name: "Browser use", status: "Unavailable" },
  ];
  return <section className="agent-section agent-capabilities-page">
    <header className="agent-section-heading"><div><h1>Platform capabilities</h1></div></header>
    <div className="agent-capability-grid">{cards.map(card => <article className="agent-capability-card" key={card.name}>
      <div className="agent-capability-main"><h2>{card.name}</h2><span className="agent-capability-status">{card.status}</span></div>
      {card.note ? <p className="text-xs text-muted-foreground">{card.note}</p> : null}
      {card.destination ? <div className="agent-capability-actions"><Button type="button" size="sm" variant="outline" onClick={() => onConfigure(card.destination!)}>Configure</Button></div> : null}
    </article>)}</div>
  </section>;
}
