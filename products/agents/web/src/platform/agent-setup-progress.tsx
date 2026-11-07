import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PiArrowRight as ArrowRight } from "react-icons/pi";
import { api, message, organizationPath, type Agent } from "./api";

type Readiness = { requirements: Record<string, { state: string; code: string | null }>; channels: Array<{ kind: string; state: string }> };
type Step = { id: string; label: string; done: boolean; section: string; action: string };

export function AgentSetupProgress({ organizationId, agentId, draftRevision }: { organizationId: string; agentId: string; draftRevision: number }) {
  const base = organizationPath(organizationId);
  const [steps, setSteps] = useState<Step[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ readiness: Readiness }>(`${base}/agents/${encodeURIComponent(agentId)}/setup-readiness`),
      api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(agentId)}`),
    ]).then(([result, current]) => {
      if (!live) return;
      const { readiness } = result;
      const responsibilities = current.agent.setup?.responsibilities ?? [];
      const knowledgeRequired = responsibilities.some(value => value === "answer-questions" || value === "customer-support");
      const capabilityKeys = responsibilities.filter(value => value === "bookings" || value === "enquiries");
      const capabilitiesDone = capabilityKeys.every(key => readiness.requirements[key]?.state !== "needs_setup");
      const knowledgeDone = !knowledgeRequired || readiness.requirements.knowledge?.state === "ready";
      const channelDone = readiness.channels.some(channel => channel.state === "connected");
      setSteps([
        { id: "profile", label: "Profile", done: true, section: "settings", action: "Review profile" },
        { id: "knowledge", label: "Knowledge", done: knowledgeDone, section: "knowledge", action: "Add knowledge" },
        { id: "model", label: "Model", done: readiness.requirements.model?.state === "ready", section: "behaviour", action: "Choose model" },
        { id: "capabilities", label: "Capabilities", done: capabilitiesDone, section: "capabilities", action: "Finish capability setup" },
        { id: "channel", label: "Channel", done: channelDone, section: "deploy", action: "Connect a channel" },
      ]);
      setError("");
    }).catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [base, agentId, draftRevision]);
  if (error) return null;
  if (!steps) return <div className="agent-setup-progress is-loading" role="status" aria-label="Loading setup progress"><span /><span /></div>;
  const done = steps.filter(step => step.done).length, next = steps.find(step => !step.done);
  return <section className="agent-setup-progress" aria-label="Setup progress">
    <div className="agent-setup-progress-head"><span>Setup</span><span>{done} of {steps.length}</span></div>
    <div className="agent-setup-progress-track" aria-hidden="true"><span style={{ width: `${done / steps.length * 100}%` }} /></div>
    {next ? <Link to={`/app/agents/${agentId}?section=${next.section}`} className="agent-setup-progress-next">{next.action}<ArrowRight size={14} /></Link> : <p className="agent-setup-progress-complete">Ready to use</p>}
  </section>;
}
