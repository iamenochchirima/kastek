import { requireAdminSession } from "@/lib/admin-auth";
import { IncidentDetail } from "@/components/admin/operations/incident-detail";
export default async function IncidentPage({params}:{params:Promise<{id:string}>}) {
 const actor=await requireAdminSession(),{id}=await params;
 return <div className="admin-page"><IncidentDetail id={id} actor={actor}/></div>;
}
