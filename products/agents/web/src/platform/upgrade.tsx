import { Link } from "react-router-dom";
import { PiArrowLeft as ArrowLeft } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "./shell";
import { BillingSettings } from "./billing-settings";
import "./management.css";
import "./workspace-surfaces.css";

export function UpgradePage() {
  const { organizationId } = useWorkspace();
  return (
    <section className="management-page max-w-6xl">
      <header className="management-header flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1>Choose a plan</h1>
          <p className="mt-1 text-sm text-muted-foreground">Plans for this Agents workspace.</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/app/settings?section=billing"><ArrowLeft className="size-4" />Billing</Link>
        </Button>
      </header>
      <BillingSettings key={`upgrade-${organizationId}`} organizationId={organizationId} view="plans" />
    </section>
  );
}
