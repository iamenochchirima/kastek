import { requireAdminSession } from "@/lib/admin-auth";
import { OperationsAudit } from "@/components/admin/operations/audit";
import { AdminPageHeader } from "@/components/admin/page-header";
export default async function AuditPage() {
 const actor=await requireAdminSession();
 if(!["security","owner","superadmin"].includes(actor.role))return <div className="admin-page"><AdminPageHeader title="Audit"/><p role="alert" className="mt-5 text-sm text-muted-foreground">Security access required</p></div>;
 return <div className="admin-page"><OperationsAudit role={actor.role}/></div>;
}
