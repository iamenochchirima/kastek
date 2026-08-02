"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleDot,
  Layers3,
  Mail,
  Mic,
  PenTool,
  Plus,
  Users,
} from "lucide-react";

type PartnerStage = "platform" | "agency" | "client";

const stages: Array<{ id: PartnerStage; label: string }> = [
  { id: "platform", label: "Kasitek platform" },
  { id: "agency", label: "Agency workspace" },
  { id: "client", label: "Client account" },
];

export function PartnershipWorkspacePreview() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<PartnerStage>("platform");
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduceMotion(media.matches);
    updateMotion();
    media.addEventListener("change", updateMotion);
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), { threshold: 0.32 });
    if (frameRef.current) observer.observe(frameRef.current);
    return () => { media.removeEventListener("change", updateMotion); observer.disconnect(); };
  }, []);

  useEffect(() => {
    if (!isVisible || reduceMotion) return;
    const interval = window.setInterval(() => {
      setStage((current) => stages[(stages.findIndex((item) => item.id === current) + 1) % stages.length].id);
    }, 4800);
    return () => window.clearInterval(interval);
  }, [isVisible, reduceMotion]);

  return (
    <div className="partner-preview" ref={frameRef} data-stage={stage}>
      <div className="partner-preview-top"><span className="partner-preview-logo">m</span><b>Moyo Studio</b><span className="partner-preview-domain">moyostudio.co.za <ChevronDown aria-hidden="true" /></span><i>MS</i></div>
      <div className="partner-preview-body">
        <aside>
          <span>Workspace</span>
          <button type="button" className={stage === "agency" ? "is-active" : ""} onClick={() => setStage("agency")}><Layers3 aria-hidden="true" />Overview</button>
          <button type="button" className={stage === "client" ? "is-active" : ""} onClick={() => setStage("client")}><Users aria-hidden="true" />Clients</button>
          <button type="button" onClick={() => setStage("client")}><Users aria-hidden="true" />Leads</button>
          <span>Delivery</span>
          <button type="button" onClick={() => setStage("agency")}><PenTool aria-hidden="true" />Content pipeline</button>
          <button type="button" onClick={() => setStage("client")}><BarChart3 aria-hidden="true" />Client reporting</button>
          <span>Automation</span>
          <button type="button" onClick={() => setStage("client")}><Mail aria-hidden="true" />Nurturing</button>
          <button type="button" onClick={() => setStage("client")}><Mic aria-hidden="true" />Voice agents</button>
          <span>Settings</span>
          <button type="button" className={stage === "platform" ? "is-active" : ""} onClick={() => setStage("platform")}><CircleDot aria-hidden="true" />Brand & domain</button>
        </aside>
        <PlatformStage active={stage === "platform"} />
        <AgencyStage active={stage === "agency"} />
        <ClientStage active={stage === "client"} />
      </div>
      <div className="partner-preview-steps">{stages.map((item, index) => <button key={item.id} type="button" className={stage === item.id ? "is-active" : ""} onClick={() => setStage(item.id)}><em>{index + 1}</em>{item.label}</button>)}</div>
    </div>
  );
}

function PlatformStage({ active }: { active: boolean }) {
  return <section className={active ? "partner-stage is-active" : "partner-stage"} aria-hidden={!active}><div className="partner-stage-heading"><span><small>Kasitek platform</small><b>Brand & domain</b></span><button type="button">Save changes</button></div><div className="brand-layout"><div className="brand-mark-edit"><i>m</i><span><b>Moyo Studio</b><small>Agency workspace</small></span><button type="button">Change logo</button></div><div className="brand-fields"><label>Primary colour <span><i /> #4C36A7</span></label><label>Custom domain <span>moyostudio.co.za <Check /></span></label><label>Workspace status <span><em /> Active</span></label></div></div></section>;
}

function AgencyStage({ active }: { active: boolean }) {
  return <section className={active ? "partner-stage is-active" : "partner-stage"} aria-hidden={!active}><div className="partner-stage-heading"><span><small>Moyo Studio</small><b>Client workspaces</b></span><button type="button"><Plus /> Add client</button></div><div className="agency-metrics"><Metric value="18" label="Active clients" /><Metric value="4" label="Services live" /><Metric value="96%" label="Tasks on track" /></div><div className="client-table"><span className="table-head">Client <i>Services</i><i>Access</i></span><ClientRow name="Kaya Dental" service="Customer & Growth" /><ClientRow name="Lena Beauty" service="Bookings & Inbox" /><ClientRow name="Naledi Foods" service="Campaigns" /></div></section>;
}

function ClientStage({ active }: { active: boolean }) {
  return <section className={active ? "partner-stage is-active" : "partner-stage"} aria-hidden={!active}><div className="partner-stage-heading"><span><small>Kaya Dental / Client account</small><b>Welcome back, Kaya Dental</b></span><button type="button">View reports <ArrowUpRight /></button></div><div className="client-welcome"><span><b>Customer enquiries</b><small>Last 30 days</small></span><strong>42</strong><em><i /> 8 need attention</em></div><div className="client-services"><article><span>Inbox</span><b>7 open conversations</b><small>View customer messages</small></article><article><span>Campaigns</span><b>1 scheduled send</b><small>Review audience and delivery</small></article></div></section>;
}

function Metric({ value, label }: { value: string; label: string }) { return <span><b>{value}</b><small>{label}</small></span>; }
function ClientRow({ name, service }: { name: string; service: string }) { return <span><b>{name}</b><i>{service}</i><i><Check /> Active</i></span>; }
