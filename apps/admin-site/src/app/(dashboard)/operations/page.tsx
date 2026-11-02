import {ReportingDiagnosticsPanel} from "@/components/admin/reporting-diagnostics-panel";
import { OperationsOverview } from "@/components/admin/operations/overview";
import { AdminWebhookReplayButton } from "@/components/admin/admin-webhook-replay-button";
import { SupportAccessPanel } from "@/components/admin/support-access-panel";
import { fetchFromCore, requireAdminSession } from "@/lib/admin-auth";

type Grant = { id:string; adminId:string; organizationId:string; resourceType:string; resourceId?:string|null; reason:string; expiresAt:string; revokedAt?:string|null };
type Delivery = { id:string; organizationId:string; eventType:string; attemptCount:number };
async function load<T>(path:string):Promise<T|null>{
  try { const response=await fetchFromCore(path);return response.ok?await response.json() as T:null; }
  catch { return null; }
}
export default async function OperationsPage() {
  const admin=await requireAdminSession(),role=admin.role.toLowerCase();
  const canCommand=["operator","admin","superadmin","owner"].includes(role);
  const canViewSupport=["support","security","operator","admin","superadmin","owner"].includes(role);
  const [webhooks,support]=await Promise.all([
    load<{deliveries:Delivery[]}>("/api/admin/operations/webhooks/deliveries?limit=50"),
    canViewSupport?load<{grants:Grant[]}>("/api/admin/operations/support-grants"):Promise.resolve(null),
  ]);
  return <div className="admin-page">
    <OperationsOverview actor={admin}/>
    <details className="mt-8 rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Diagnostics and recovery</summary>
    <div className="mt-5 space-y-5">
      <ReportingDiagnosticsPanel/>
      <section className="v-card overflow-hidden">
        <h2 className="border-b border-border px-5 py-4 text-sm font-semibold">Webhook recovery</h2>
        {webhooks===null?<p role="status" className="p-5 text-sm text-muted-foreground">Webhook recovery unavailable</p>:
          webhooks.deliveries.length===0?<p className="p-5 text-sm text-muted-foreground">No failed deliveries</p>:
          <div className="divide-y divide-border">{webhooks.deliveries.map(delivery=><div key={delivery.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <div className="min-w-0"><p className="break-all font-mono text-xs">{delivery.id}</p><p className="text-xs text-muted-foreground">{delivery.organizationId} · {delivery.eventType} · attempt {delivery.attemptCount}</p></div>
            {canCommand?<AdminWebhookReplayButton deliveryId={delivery.id} expectedAttemptCount={delivery.attemptCount}/>:<span className="text-xs text-muted-foreground">Read-only</span>}
          </div>)}</div>}
      </section>
      {canViewSupport?<section className="v-card overflow-hidden">
        <h2 className="border-b border-border px-5 py-4 text-sm font-semibold">Support access</h2>
        {support===null?<p role="status" className="p-5 text-sm text-muted-foreground">Support access unavailable</p>:<div className="p-5"><SupportAccessPanel initialGrants={support.grants} adminId={admin.id} canManage={["admin","superadmin","owner"].includes(role)}/></div>}
      </section>:null}
    </div>
    </details>
  </div>;
}
