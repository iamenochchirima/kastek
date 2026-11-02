import { adminCapabilities } from "@kasitek-labs/server-support/admin-authority";
import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";
import { submitOutreach } from "@/lib/outreach-submit";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; leadId: string }> }) {
  const admin=await getAdminSession();
  if (!admin) return NextResponse.json({error:'Unauthorized'},{status:401});
  if (!adminCapabilities(admin.role).has('admin:write')) return NextResponse.json({error:'Forbidden'},{status:403});
  const {id:campaignId,leadId}=await params;
  const leadRes=await fetchFromCore(`/api/admin/outreach/${campaignId}/leads/${leadId}`);
  if (!leadRes.ok) return NextResponse.json({error:'Could not load lead'},{status:leadRes.status});
  const lead=await leadRes.json() as {emailAddress:string|null};
  const body=await req.json().catch(()=>null);
  if (!body || typeof body!=='object') return NextResponse.json({error:'Invalid request'},{status:400});
  const raw=body.to ?? lead.emailAddress;
  const to=[...new Set((Array.isArray(raw)?raw:[raw]).map(v=>String(v ?? '').trim().toLowerCase()).filter(Boolean))];
  const subject=String(body.subject ?? '').trim(),text=String(body.text ?? body.emailBody ?? '').trim();
  if (!to.length || !subject || !text || to.some(v=>!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v))) return NextResponse.json({error:'Valid recipients, subject and text are required'},{status:400});
  try {
    await verifySmtpTransport();
    const result=await submitOutreach({campaignId,leadId,to,subject,text,...(body.html?{html:String(body.html)}:{}),...(body.retryOf?{retryOf:String(body.retryOf)}:{})},{core:fetchFromCore,send:sendSmtpMail});
    return NextResponse.json(result.body,{status:result.status});
  } catch {
    return NextResponse.json({ok:false,error:'SMTP is unavailable. No submission was started.'},{status:503});
  }
}
