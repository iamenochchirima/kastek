import {proxyToCore} from "@/lib/admin-auth";
export async function POST(request:Request,{params}:{params:Promise<Record<string,string>>}) { const values=await params; return proxyToCore(request,`/api/admin/outreach/send-attempts/${values.attemptId}/reconcile`); }
