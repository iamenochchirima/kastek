import { requireAdminSession } from "@/lib/admin-auth";
import { OperationsSettings } from "@/components/admin/operations/settings";
export default async function MonitoringPage() {
 const actor=await requireAdminSession();
 return <div className="admin-page"><OperationsSettings actor={actor}/></div>;
}
