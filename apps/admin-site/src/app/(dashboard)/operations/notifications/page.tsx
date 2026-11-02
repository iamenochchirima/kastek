import { requireAdminSession } from "@/lib/admin-auth";
import { OperationsNotifications } from "@/components/admin/operations/notifications";
export default async function NotificationsPage() {
 const actor=await requireAdminSession();
 return <div className="admin-page"><OperationsNotifications role={actor.role}/></div>;
}
