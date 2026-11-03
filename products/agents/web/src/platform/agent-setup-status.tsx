import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PiGlobe as Globe } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage } from "./shell";
import { channelNames, type ChannelKind } from "./channel-api";
type Readiness = { readyToTest: boolean; setupStep: string | null; requirements: Record<string,{state:string;code:string|null}>; channels: Array<{kind:ChannelKind;state:string}> };
const labels: Record<string,string> = {model:"Model",knowledge:"Knowledge",customerKnowledge:"Customer knowledge",bookings:"Appointments",enquiries:"Enquiries",handoff:"Human support"};
const reasons: Record<string,string> = {BOOKING_POLICY_REQUIRED:"Connect calendar",ENQUIRY_CAPABILITY_REQUIRED:"Finish enquiry setup",KNOWLEDGE_NOT_APPROVED:"Review knowledge",KNOWLEDGE_NOT_PUBLIC:"Allow customer replies",MODEL_DEFAULT_REQUIRED:"Choose model",MODEL_CREDENTIAL_UNAVAILABLE:"Reconnect provider"};
const channelLogos: Partial<Record<ChannelKind, string>> = { whatsapp: "whatsapp", telegram: "telegram", facebook: "messenger", instagram: "instagram" };
const stateLabels: Record<string,string> = {connected:"Connected",paused:"Paused",needs_connection:"Not connected",needs_attention:"Needs attention"};
export function AgentSetupStatus({organizationId,agent,compact=false}:{organizationId:string;agent:Agent;compact?:boolean}) {
 const [readiness,setReadiness]=useState<Readiness|null>(null),[error,setError]=useState(""),[generation,setGeneration]=useState(0);
 useEffect(()=>{let live=true;api<{readiness:Readiness}>(`${organizationPath(organizationId)}/agents/${agent.id}/setup-readiness`).then(result=>{if(live){setReadiness(result.readiness);setError("");}}).catch(e=>{if(live)setError(message(e));});return()=>{live=false;};},[organizationId,agent.id,agent.draftRevision,generation]);
 if(!agent.setup)return null;
 const returnTo=`/app/agents/${agent.id}?section=configuration`;
 return <div className={`agent-setup-layout${compact ? " is-compact" : ""}`}>
  <section aria-label="Agent setup" className="agent-config-panel agent-setup-readiness">
   <div className="agent-setup-heading"><h2>Setup status</h2>{!compact ? <Button type="button" size="sm" variant="ghost" onClick={()=>setGeneration(value=>value+1)}>Refresh</Button> : null}</div>
   <ErrorMessage value={error}/>{!readiness&&!error?<div role="status" className="h-16 animate-pulse rounded bg-muted" aria-label="Loading setup"/>:null}
   {readiness?<dl className="agent-readiness-list">{Object.entries(readiness.requirements).filter(([key,value])=>value.state!=="deferred"||key==="knowledge").map(([key,value])=><div key={key}><dt>{labels[key]??key}</dt><dd data-state={value.state}>{value.state==="ready"?"Ready":value.state==="deferred"?"Not added":reasons[value.code??""]??"Needs setup"}</dd></div>)}</dl>:null}
   {!compact ? <div className="agent-setup-actions"><Link to={`/app/agents/${agent.id}?setup=guided`}>{agent.setupStep === "complete" ? "Edit setup" : "Continue setup"}</Link>{readiness?.requirements.model && !["ready","deferred"].includes(readiness.requirements.model.state) ? <Link to="/app/settings?section=models">Manage model providers</Link> : null}</div> : null}
  </section>
  {!compact && readiness?.channels.length ? <section aria-label="Connected channels" className="agent-config-panel agent-channels-panel"><h2>Connected channels</h2><div className="agent-channel-list">{readiness.channels.map(channel=>{const logo=channelLogos[channel.kind];return <div key={channel.kind} className="agent-channel-row"><span className="agent-channel-name">{logo ? <img src={`/images/integrations/${logo}.svg`} width="18" height="18" alt="" /> : <Globe size={18} aria-hidden="true" />}{channelNames[channel.kind]}</span><span className="agent-channel-state" data-state={channel.state}>{stateLabels[channel.state]??channel.state}</span><Link to={`/app/connections?agentId=${encodeURIComponent(agent.id)}&channel=${channel.kind}&returnTo=${encodeURIComponent(returnTo)}`}>{channel.state==="connected"?"Manage":"Connect"}</Link></div>;})}</div></section> : null}
 </div>;
}
