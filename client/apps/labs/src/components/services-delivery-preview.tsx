"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ClipboardList, Globe2, MessageSquare, PlugZap, Wrench } from "lucide-react";

type ServiceStage = "scope" | "build" | "operate";

const stages: Array<{ id: ServiceStage; label: string; note: string }> = [
  { id: "scope", label: "Find the friction", note: "Map the handoffs and the work that is getting in the way." },
  { id: "build", label: "Build the useful thing", note: "Connect the parts into a system your team can actually use." },
  { id: "operate", label: "Stay for the outcome", note: "Support, refine and measure the work after launch." },
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
      <div className="service-preview-head"><span>Delivery workspace</span><span>Illustrative project view</span></div>
      <div className="service-preview-body">
        <div className="service-brief">
          <span className="service-kicker">Project / Northstar Studio</span>
          <h3>{current.label}</h3>
          <p>{current.note}</p>
          <div className="service-stage-tabs">
            {stages.map((item) => <button key={item.id} type="button" className={stage === item.id ? "is-active" : ""} onClick={() => setStage(item.id)}>{item.label}</button>)}
          </div>
        </div>

        <div className="service-canvas" aria-label="Example service delivery system">
          <div className="service-canvas-grid" />
          <div className="service-route route-one" /><div className="service-route route-two" /><div className="service-route route-three" />
          <ServiceNode className="node-brief" icon={ClipboardList} label="Project brief" meta="Customer enquiry" active={stage === "scope"} />
          <ServiceNode className="node-site" icon={Globe2} label="Website & form" meta="Lead capture" active={stage !== "scope"} />
          <ServiceNode className="node-inbox" icon={MessageSquare} label="Inbox" meta="Team response" active={stage !== "scope"} />
          <ServiceNode className="node-connect" icon={PlugZap} label="Integration" meta="Booking & CRM" active={stage === "build" || stage === "operate"} />
          <ServiceNode className="node-support" icon={Wrench} label="Managed support" meta="Review & improve" active={stage === "operate"} />
          <div className="service-outcome"><Check aria-hidden="true" /><span>System in use</span></div>
          <span className="service-cursor" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

function ServiceNode({ className, icon: Icon, label, meta, active }: { className: string; icon: typeof ClipboardList; label: string; meta: string; active: boolean }) {
  return <div className={`service-node ${className}${active ? " is-active" : ""}`}><Icon aria-hidden="true" /><span><b>{label}</b><small>{meta}</small></span><ArrowRight aria-hidden="true" /></div>;
}
