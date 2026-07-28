import Image from "next/image";
import {
  ArrowRight,
  Bot,
  Braces,
  Check,
  Layers3,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

export function ServiceDeliveryMontage() {
  return (
    <div className="service-delivery">
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
          <div className="montage-card-kicker">
            <span><Bot aria-hidden="true" />Customer intake agent</span>
            <em>Review</em>
          </div>
          <div className="montage-agent-request">
            <small>New enquiry</small>
            <p>We need a service across two locations. Can you review the request?</p>
          </div>
          <div className="montage-agent-context">
            <span>Customer record</span>
            <span>Service rules</span>
            <span>Team capacity</span>
          </div>
          <div className="montage-agent-response">
            <Sparkles aria-hidden="true" />
            <span><strong>Action plan prepared</strong>Record matched, route selected and reply drafted.</span>
          </div>
          <small className="montage-control-note"><ShieldCheck aria-hidden="true" />Approval before action</small>
        </article>

        <article className="montage-workflow-card">
          <div className="montage-card-kicker">
            <span><Braces aria-hidden="true" />Workflow integration</span>
            <em>Running</em>
          </div>
          <div className="montage-workflow-route">
            <span>Enquiry</span>
            <ArrowRight aria-hidden="true" />
            <b><Bot aria-hidden="true" />Agent</b>
            <ArrowRight aria-hidden="true" />
            <span>CRM</span>
            <ArrowRight aria-hidden="true" />
            <span>Team</span>
          </div>
          <small><i />Record updated · task created · response prepared</small>
        </article>

        <article className="montage-app-card">
          <div className="montage-browser-top"><i /><i /><i /><span>client operations portal</span></div>
          <div className="montage-app-content">
            <aside><i /><i className="is-active" /><i /><i /></aside>
            <main>
              <div><b>Customer requests</b><span>Live</span></div>
              <section>
                <span><small>Open</small><strong>12</strong></span>
                <span><small>Assigned</small><strong>9</strong></span>
              </section>
              <div className="montage-app-row"><span>New service request</span><b>Assigned</b></div>
              <div className="montage-app-row"><span>Customer reply</span><b>Prepared</b></div>
            </main>
          </div>
        </article>

        <article className="montage-kasitek-card">
          <div className="montage-card-kicker">
            <span><Layers3 aria-hidden="true" />Kasitek implementation</span>
            <em>Configured</em>
          </div>
          <div className="montage-kasitek-modules">
            <span>Customer</span>
            <span>Growth</span>
            <span>Agents</span>
          </div>
          <small><i />Workspace connected to the client operation</small>
        </article>

        <div className="montage-story-caption">
          <span>One engagement</span>
          <p>The agent, integrations and operational software delivered as one working system.</p>
          <Check aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}
