"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ClipboardList, Globe2, MessageSquare, PlugZap, Wrench } from "lucide-react";

type ServiceStage = "scope" | "build" | "operate";

const stages: Array<{ id: ServiceStage; label: string; note: string }> = [
  { id: "scope", label: "Understand the workflow", note: "We look at the people, tools and handoffs involved before deciding what to change." },
  { id: "build", label: "Design and implement", note: "We configure Kasitek, build the required integrations, and develop the parts that do not already exist." },
  { id: "operate", label: "Support the operation", note: "We stay involved after launch to maintain, improve and extend the system." },
];

export function ServicesDeliveryPreview() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<ServiceStage>("scope");
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduceMotion(media.matches);
    updateMotion();
    media.addEventListener("change", updateMotion);
    const observer = new IntersectionObserver(([entry]) => setIsVisible(entry.isIntersecting), { threshold: 0.3 });
    if (frameRef.current) observer.observe(frameRef.current);
    return () => { media.removeEventListener("change", updateMotion); observer.disconnect(); };
  }, []);

  useEffect(() => {
    if (!isVisible || reduceMotion) return;
    const interval = window.setInterval(() => {
      setStage((current) => stages[(stages.findIndex((item) => item.id === current) + 1) % stages.length].id);
    }, 4600);
    return () => window.clearInterval(interval);
  }, [isVisible, reduceMotion]);

  const current = stages.find((item) => item.id === stage)!;

  return (
    <div className="service-preview" ref={frameRef} data-stage={stage}>
      <div className="service-preview-head"><span>Service delivery</span><span>Northstar Studio</span></div>
      <div className="service-preview-body">
        <div className="service-brief">
          <span className="service-kicker">Work in progress</span>
          <h3>{current.label}</h3>
          <p>{current.note}</p>
          <div className="service-stage-tabs">
            {stages.map((item) => <button key={item.id} type="button" className={stage === item.id ? "is-active" : ""} onClick={() => setStage(item.id)}>{item.label}</button>)}
          </div>
        </div>

        <div className="service-canvas" aria-label="Example service delivery system">
          <div className="service-canvas-grid" />
          <div className="service-route route-one" /><div className="service-route route-two" /><div className="service-route route-three" />
          <ServiceNode className="node-brief" icon={ClipboardList} label="Current workflow" meta="People & handoffs" active={stage === "scope"} />
          <ServiceNode className="node-site" icon={Globe2} label="Website & forms" meta="Customer entry points" active={stage !== "scope"} />
          <ServiceNode className="node-inbox" icon={MessageSquare} label="Kasitek workspace" meta="Customer work" active={stage !== "scope"} />
          <ServiceNode className="node-connect" icon={PlugZap} label="Connected tools" meta="Bookings & CRM" active={stage === "build" || stage === "operate"} />
          <ServiceNode className="node-support" icon={Wrench} label="Ongoing support" meta="Maintain & improve" active={stage === "operate"} />
          <div className="service-outcome"><Check aria-hidden="true" /><span>In use</span></div>
          <span className="service-cursor" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function ServiceNode({ className, icon: Icon, label, meta, active }: { className: string; icon: typeof ClipboardList; label: string; meta: string; active: boolean }) {
  return <div className={`service-node ${className}${active ? " is-active" : ""}`}><Icon aria-hidden="true" /><span><b>{label}</b><small>{meta}</small></span><ArrowRight aria-hidden="true" /></div>;
}
