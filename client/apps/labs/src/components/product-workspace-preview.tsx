"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Bot,
  CalendarCheck,
  Check,
  ChevronDown,
  CircleDot,
  FileText,
  Inbox,
  LayoutGrid,
  MoreHorizontal,
  Search,
  Send,
  Sparkles,
  Users,
} from "lucide-react";

type Scene = "customer" | "growth" | "automation";

const scenes: Array<{ id: Scene; label: string; description: string }> = [
  { id: "customer", label: "Customer", description: "Conversation and booking context" },
  { id: "growth", label: "Growth", description: "Campaign activity and delivery" },
  { id: "automation", label: "Automation", description: "Agent activity and review" },
];

export function ProductWorkspacePreview() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene>("customer");
  const [isVisible, setIsVisible] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReduceMotion(media.matches);
    updateMotion();
    media.addEventListener("change", updateMotion);

    const observer = new IntersectionObserver(
      ([entry]) => setIsVisible(entry.isIntersecting),
      { threshold: 0.35 },
    );
    if (frameRef.current) observer.observe(frameRef.current);

    return () => {
      media.removeEventListener("change", updateMotion);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!isVisible || reduceMotion) return;
    const interval = window.setInterval(() => {
      setScene((current) => scenes[(scenes.findIndex((item) => item.id === current) + 1) % scenes.length].id);
    }, 4800);
    return () => window.clearInterval(interval);
  }, [isVisible, reduceMotion]);

  return (
    <div className="product-preview" ref={frameRef} data-scene={scene}>
      <div className="product-preview-bar">
        <span className="product-preview-brand"><i>K</i> Kasitek</span>
        <span className="product-preview-workspace">Northstar Studio <ChevronDown aria-hidden="true" /></span>
        <div className="product-preview-actions"><Search aria-hidden="true" /><Bell aria-hidden="true" /><span>NS</span></div>
      </div>

      <div className="product-preview-body">
        <aside className="product-preview-nav" aria-label="Kasitek workspace sections">
          <span className="nav-label">Workspace</span>
          <NavItem icon={LayoutGrid} label="Overview" />
          <span className="nav-label">Customer</span>
          <NavItem icon={Inbox} label="Inbox" active={scene === "customer"} />
          <NavItem icon={Users} label="Contacts" />
          <NavItem icon={CalendarCheck} label="Bookings" />
          <span className="nav-label">Growth</span>
          <NavItem icon={Send} label="Campaigns" active={scene === "growth"} />
          <NavItem icon={FileText} label="Content" />
          <span className="nav-label">Automation</span>
          <NavItem icon={Bot} label="Agents" active={scene === "automation"} />
        </aside>

        <div className="product-preview-main">
          <div className="product-preview-topline">
            <div>
              <span className="scene-kicker">{scenes.find((item) => item.id === scene)?.description}</span>
              <strong>{scenes.find((item) => item.id === scene)?.label}</strong>
            </div>
            <span className="workspace-status"><i /> Workspace active</span>
          </div>

          <CustomerScene active={scene === "customer"} />
          <GrowthScene active={scene === "growth"} />
          <AutomationScene active={scene === "automation"} />
        </div>
      </div>

      <div className="preview-controls" aria-label="Preview states">
        {scenes.map((item) => (
          <button key={item.id} type="button" className={scene === item.id ? "is-active" : ""} onClick={() => setScene(item.id)}>
            <span>{item.label}</span><i aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

function NavItem({ icon: Icon, label, active = false }: { icon: typeof Inbox; label: string; active?: boolean }) {
  return <span className={active ? "preview-nav-item is-active" : "preview-nav-item"}><Icon aria-hidden="true" />{label}</span>;
}

function CustomerScene({ active }: { active: boolean }) {
  return <section className={active ? "workspace-scene is-active customer-scene" : "workspace-scene customer-scene"} aria-hidden={!active}>
    <div className="conversation-list">
      <div className="conversation-search"><Search aria-hidden="true" /> Search conversations</div>
      <Conversation initials="TM" name="Thando Mokoena" message="I would like to book a consultation." active />
      <Conversation initials="SV" name="Sive Vena" message="Thank you, that works for me." />
      <Conversation initials="KN" name="Kamo Ndlovu" message="Can I get a quote first?" />
    </div>
    <div className="conversation-thread">
      <div className="thread-title"><span><b>Thando Mokoena</b><small>WhatsApp · 2 min ago</small></span><MoreHorizontal aria-hidden="true" /></div>
      <div className="message customer-message">Hi, I would like to book a consultation for next week.</div>
      <div className="message agent-message"><Sparkles aria-hidden="true" /> I can help with that. I have a few times available on Tuesday and Thursday.</div>
      <div className="message customer-message">Thursday morning would be great.</div>
      <div className="reply-bar">Write a reply <Send aria-hidden="true" /></div>
    </div>
    <aside className="contact-panel">
      <div className="contact-avatar">TM</div><b>Thando Mokoena</b><span>Customer since May</span>
      <div className="contact-detail"><small>Next booking</small><strong>Thu, 10:00</strong></div>
      <div className="contact-detail"><small>Recent activity</small><strong>Campaign reply</strong></div>
    </aside>
  </section>;
}

function Conversation({ initials, name, message, active = false }: { initials: string; name: string; message: string; active?: boolean }) {
  return <div className={active ? "conversation is-active" : "conversation"}><i>{initials}</i><span><b>{name}</b><small>{message}</small></span>{active ? <em>2</em> : null}</div>;
}

function GrowthScene({ active }: { active: boolean }) {
  return <section className={active ? "workspace-scene is-active growth-scene" : "workspace-scene growth-scene"} aria-hidden={!active}>
    <div className="campaign-heading"><span><b>Campaigns</b><small>WhatsApp delivery activity</small></span><button type="button">New campaign</button></div>
    <div className="campaign-grid">
      <article className="campaign-card campaign-primary"><span className="campaign-badge">Sending</span><h3>Winter consultation follow-up</h3><p>June booking enquiries · WhatsApp</p><div className="campaign-progress"><span><i /></span><b>74%</b></div><footer><span>1,480 recipients</span><span>1,095 delivered</span></footer></article>
      <article className="campaign-card"><span className="campaign-badge quiet">Scheduled</span><h3>July availability</h3><p>Past customers · 12 Jul, 09:00</p><div className="campaign-metrics"><span><b>386</b> recipients</span><span><b>1</b> template</span></div></article>
      <article className="campaign-card"><span className="campaign-badge quiet">Complete</span><h3>New service launch</h3><p>Customer list · 04 Jul</p><div className="campaign-metrics"><span><b>94%</b> delivered</span><span><b>38%</b> read</span></div></article>
    </div>
  </section>;
}

function AutomationScene({ active }: { active: boolean }) {
  return <section className={active ? "workspace-scene is-active automation-scene" : "workspace-scene automation-scene"} aria-hidden={!active}>
    <div className="automation-heading"><span><b>Agents</b><small>Activity across your workspace</small></span><button type="button">Configure agent</button></div>
    <div className="automation-layout">
      <article className="agent-summary"><div className="agent-orb"><Bot aria-hidden="true" /></div><span><small>Customer enquiries</small><b>Reception assistant</b><em><CircleDot aria-hidden="true" /> Active</em></span><MoreHorizontal aria-hidden="true" /></article>
      <div className="activity-list">
        <Activity title="Qualified an enquiry" detail="Thando Mokoena · Consultation" time="Now" />
        <Activity title="Created a booking task" detail="Follow up Thursday, 10:00" time="2m" />
        <Activity title="Handed over to team" detail="Pricing request needs review" time="8m" />
      </div>
      <article className="review-card"><span><Check aria-hidden="true" /> Review queue</span><b>1 item needs a decision</b><p>Pricing request from Kamo Ndlovu</p><button type="button">Open review</button></article>
    </div>
  </section>;
}

function Activity({ title, detail, time }: { title: string; detail: string; time: string }) {
  return <div className="activity"><i /><span><b>{title}</b><small>{detail}</small></span><time>{time}</time></div>;
}
