import { Check } from "lucide-react";

export function ForwardDeployedDelivery() {
  return (
    <section className="forward-delivery section-pad" id="delivery">
      <div className="forward-delivery-intro">
        <h2>Forward-deployed delivery.</h2>
        <p>
          Our engineers work directly with your team from solution design
          through launch and iteration.
        </p>
      </div>

      <ol className="forward-delivery-stages">
        <li>
          <strong>Define</strong>
          <span>The job, existing systems and success measure.</span>
        </li>
        <li>
          <strong>Build</strong>
          <span>The agent, integrations and working interface.</span>
        </li>
        <li>
          <strong>Launch</strong>
          <span>Access, approvals, fallbacks and team readiness.</span>
        </li>
        <li>
          <strong>Improve</strong>
          <span>Usage reviewed and the system extended.</span>
        </li>
      </ol>

      <div className="forward-delivery-controls" aria-label="Delivery controls">
        <span><Check aria-hidden="true" />Human approvals</span>
        <span><Check aria-hidden="true" />Controlled access</span>
        <span><Check aria-hidden="true" />Evaluation before launch</span>
        <span><Check aria-hidden="true" />Managed deployment</span>
      </div>
    </section>
  );
}
