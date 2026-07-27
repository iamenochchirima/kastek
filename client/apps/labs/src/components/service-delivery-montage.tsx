import Image from "next/image";
import { ArrowRight, Bot, Braces, CalendarDays, Check, MessageCircle, Sparkles } from "lucide-react";

export function ServiceDeliveryMontage() {
  return (
    <div className="service-montage">
      <Image
        className="service-montage-image"
        src="/images/service-delivery-editorial-v1.png"
        alt="A software delivery project being worked through at a studio table"
        fill
        sizes="(max-width: 900px) 100vw, 62vw"
        priority={false}
      />
      <div className="service-montage-shade" />
      <article className="montage-agent-card">
        <div className="montage-card-kicker"><Bot aria-hidden="true" />AI agent</div>
        <p>Can I book a consultation for Thursday?</p>
        <div><Sparkles aria-hidden="true" />I&apos;ve found two times. Which works for you?</div>
        <small>Customer work, with your team in control</small>
      </article>

      <article className="montage-workflow-card">
        <div className="montage-card-kicker"><Braces aria-hidden="true" />Workflow integration</div>
        <div className="montage-workflow-route"><span>Form</span><ArrowRight aria-hidden="true" /><b><Braces aria-hidden="true" />AI</b><ArrowRight aria-hidden="true" /><span>CRM</span></div>
        <small><i />Qualified enquiry routed to the team</small>
      </article>

      <article className="montage-app-card">
        <div className="montage-browser-top"><i /><i /><i /><span>client application</span></div>
        <div className="montage-app-content">
          <aside><i /><i /><i className="is-active" /><i /></aside>
          <main>
            <div><b>Appointments</b><span>July</span></div>
            <section><span><small>Today</small><strong>12</strong></span><span><small>Confirmed</small><strong>9</strong></span></section>
            <p><CalendarDays aria-hidden="true" />Thursday consultation <b>10:00</b></p>
          </main>
        </div>
      </article>

      <div className="montage-service-list" aria-label="Services we deliver">
        <span>AI agents</span>
        <span>AI workflows</span>
        <span>Systems integration</span>
        <span>Web applications</span>
        <span>Websites &amp; bookings</span>
      </div>
      <div className="montage-footer"><MessageCircle aria-hidden="true" /><span>Built close to the work. Improved in use.</span><Check aria-hidden="true" /></div>
    </div>
  );
}
