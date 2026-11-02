import { adminCapabilities } from "@kasitek-labs/server-support/admin-authority";
import { NextResponse } from "next/server";
import { getAdminSession, fetchFromCore } from "@/lib/admin-auth";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";
import { submitOutreach } from "@/lib/outreach-submit";

export async function POST(req: Request) {
  const admin=await getAdminSession();
  if(!admin) return NextResponse.json({error:"Unauthorized"},{status:401});
  if(!adminCapabilities(admin.role).has("admin:write")) return NextResponse.json({error:"Forbidden"},{status:403});
  const body=await req.json().catch(()=>({}));
  const to=String(body.to ?? admin.email).trim().toLowerCase();
  const subject=String(body.subject ?? '').trim(),text=String(body.text ?? body.emailBody ?? '').trim();
  if(!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to) || !subject || !text) return NextResponse.json({error:"Recipient, subject and text are required"},{status:400});
  try {
    await verifySmtpTransport();
    const response=await fetchFromCore('/api/admin/outreach/test-recipient',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:to})});
    if(!response.ok) return NextResponse.json({error:'Could not prepare test recipient'},{status:response.status});
    const {campaignId,leadId}=await response.json() as {campaignId:string;leadId:string};
    const result=await submitOutreach({campaignId,leadId,to:[to],subject,text,...(body.html?{html:String(body.html)}:{}),...(body.retryOf?{retryOf:String(body.retryOf)}:{})},{core:fetchFromCore,send:sendSmtpMail});
    return NextResponse.json(result.body,{status:result.status});
  } catch {return NextResponse.json({error:'SMTP is unavailable. No submission was started.'},{status:503});}
}
