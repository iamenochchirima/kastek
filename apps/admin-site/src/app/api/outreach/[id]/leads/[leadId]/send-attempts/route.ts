import {proxyToCore} from "@/lib/admin-auth";
export async function GET(request:Request,{params}:{params:Promise<Record<string,string>>}) { const values=await params; return proxyToCore(request,`/api/admin/outreach/${values.id}/leads/${values.leadId}/send-attempts`); }
