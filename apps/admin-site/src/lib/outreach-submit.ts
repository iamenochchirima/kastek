import { createHash } from 'node:crypto';
export type Submission = { campaignId: string; leadId: string; to: string[]; subject: string; text: string; html?: string; retryOf?: string };
type SmtpResult = { accepted?: unknown[]; rejected?: unknown[]; messageId?: string };
type Ports = {
  core: (path: string, init?: RequestInit) => Promise<Response>;
  send: (input: {to:string;subject:string;text:string;html?:string}) => Promise<SmtpResult>;
};
export async function submitOutreach(input: Submission, ports: Ports): Promise<{status:number;body:Record<string, unknown>}> {
  const fingerprint=createHash('sha256').update(JSON.stringify([input.campaignId,input.leadId,[...input.to].sort(),input.subject,input.text,input.html ?? ''])).digest('hex');
  const post=(path:string,body:unknown) => ports.core(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const claim=await post(`/api/admin/outreach/${input.campaignId}/leads/${input.leadId}/send-attempts`,{fingerprint,recipients:input.to,subject:input.subject,retryOf:input.retryOf});
  if (!claim.ok) return {status:claim.status,body:await claim.json()};
  const attempt=await claim.json() as {id:string};
  let accepted:string[]=[],rejected:string[]=[],messageId:string|undefined;
  try {
    const info=await ports.send({...input,to:input.to.join(', ')});
    const addresses=(list:unknown[]|undefined) => (list ?? []).map(v=>typeof v==='object' && v!==null && 'address' in v ? String(v.address) : String(v)).map(v=>v.trim().toLowerCase());
    accepted=addresses(info.accepted);rejected=addresses(info.rejected);messageId=info.messageId;
  } catch {
    // SMTP transport failures can follow acceptance. Keep the claim blocked until reconciled.
    try { await post(`/api/admin/outreach/send-attempts/${attempt.id}/complete`,{accepted:[],rejected:[]}); } catch { /* The durable submitting claim still blocks resend. */ }
    return {status:502,body:{ok:false,status:'uncertain',attemptId:attempt.id,error:'SMTP outcome is uncertain. Reconcile the send attempt before retrying.'}};
  }
  try {
    const result=await post(`/api/admin/outreach/send-attempts/${attempt.id}/complete`,{accepted,rejected,messageId});
    if (!result.ok) throw new Error('Could not persist SMTP outcome');
    const recorded=await result.json() as {status:string};
    const complete=recorded.status==='accepted';
    return {status:complete?200:502,body:{ok:complete,status:recorded.status,attemptId:attempt.id,accepted,rejected,messageId,...(!complete?{error:recorded.status==='partial'?'Some recipients were rejected by SMTP.':'SMTP submission was not fully accepted.'}:{})}};
  } catch {
    return {status:502,body:{ok:false,status:'uncertain',attemptId:attempt.id,error:'SMTP returned a result but it could not be recorded. Reconcile the send attempt before retrying.'}};
  }
}
