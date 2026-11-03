import { useEffect, useState } from "react";
import { Link, redirect, useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";
import { toast } from "sonner";

type ReviewPreview = {
  postId?:string;title?:string;content?:string;previousContent?:string;scheduledFor?:string;targetLabel?:string;
  validation?:{ready:boolean;errors:Array<{code:string;message:string}>};
  variants?:Array<{platform:string;content:string}>;
  accounts?:Array<{id:string;platform:string;displayName:string;handle?:string;externalAccountId:string}>;
  media?:Array<{assetId:string;fileName?:string;mimeType?:string}>;
  removedMedia?:Array<{assetId:string;fileName?:string;mimeType?:string}>;
};
type Review = {preview?:ReviewPreview;requestId?:string;id:string;operation:string;state:string;payloadDigest:string;input:unknown;result:unknown;reviewUrl:string;expiresAt:string;errorCode?:string|null};
export function meta() { return [{title:"Review action | KasiTek"},{name:"robots",content:"noindex, nofollow"}]; }
export async function clientLoader({request,params}:ClientLoaderFunctionArgs) {
  const url=new URL(request.url),session=await getWorkspaceSession(request);
  if(!session?.user?.id)throw redirect(`/login?returnTo=${encodeURIComponent(url.pathname+url.search)}`);
  const response=await fetch(`/api/operations/reviews/${encodeURIComponent(params.id??"")}`,{credentials:"include",cache:"no-store",signal:request.signal});
  if(!response.ok)return {review:null,error:response.status===404?"This review is unavailable in this workspace.":"Could not load this review."};
  return {review:((await response.json()) as {review:Review}).review,error:""};
}
export default function OperationReviewPage() {
  const initial=useLoaderData<typeof clientLoader>();
  return <OperationReviewContent key={initial.review?.id??initial.error} initial={initial} />;
}
const operationLabels:Record<string,string>={
  "content.posts.draft.create":"Create draft","content.posts.draft.update":"Update draft","content.posts.duplicate":"Duplicate post",
  "content.posts.update_published":"Update published post",
  "content.posts.publish":"Publish post","content.posts.publish_batch":"Publish to accounts","content.posts.schedule":"Schedule post",
  "content.posts.reschedule":"Reschedule post","content.posts.unschedule":"Remove schedule","content.posts.delete":"Delete draft",
  "content.posts.delete_published":"Delete published post","content.jobs.cancel":"Cancel publication","content.jobs.retry":"Retry publication",
  "content.media.upload":"Save media","content.media.transfer.finalize":"Save uploaded media","connections.status.update":"Update connection",
  "inbox.messages.send":"Send message","inbox.conversations.update":"Update conversation","inbox.conversations.mark_read":"Mark conversation read","contacts.update":"Update contact",
};
function ContentPreview({preview}:{preview:ReviewPreview}) {
  return <section aria-label="Content preview" className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-5">
    {preview.validation?.errors.length?<div role="alert" className="space-y-1 text-sm text-destructive">{preview.validation.errors.map((error,index)=><p key={`${error.code}:${index}`}>{error.message}</p>)}</div>:null}
    {preview.targetLabel?<dl className="text-sm"><dt className="text-xs text-muted-foreground">Target</dt><dd className="mt-1 break-words font-medium">{preview.targetLabel}</dd></dl>:null}
    {preview.title?<h3 className="break-words text-base font-semibold">{preview.title}</h3>:null}
    {preview.previousContent!==undefined?<dl className="space-y-1 text-sm"><dt className="text-xs text-muted-foreground">Current text</dt><dd className="whitespace-pre-wrap break-words leading-6">{preview.previousContent}</dd></dl>:null}
    {preview.removedMedia?.length?<section aria-label="Photo removal" className="space-y-1"><h3 className="text-sm font-medium">Remove photo</h3>{preview.removedMedia.map(asset=><p key={asset.assetId} className="break-all text-sm text-muted-foreground">{asset.fileName||asset.assetId}</p>)}</section>:null}
    {preview.content?<div>{preview.previousContent!==undefined?<p className="mb-1 text-xs text-muted-foreground">Updated text</p>:null}<p className="whitespace-pre-wrap break-words text-sm leading-6">{preview.content}</p></div>:null}
    {preview.scheduledFor?<dl className="text-sm"><dt className="text-xs text-muted-foreground">Scheduled for</dt><dd className="mt-1 break-words">{new Date(preview.scheduledFor).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"long"})}</dd></dl>:null}
    {preview.variants?.length?<section className="space-y-3" aria-label="Platform content">{preview.variants.map((variant,index)=><div key={`${variant.platform}:${index}`} className="space-y-1 border-l-2 border-border pl-3"><h4 className="text-xs font-medium text-muted-foreground">{variant.platform}</h4><p className="whitespace-pre-wrap break-words text-sm leading-6">{variant.content}</p></div>)}</section>:null}
    {preview.accounts?.length?<section aria-label="Selected accounts" className="space-y-2"><h3 className="text-sm font-medium">Accounts</h3><ul className="space-y-2">{preview.accounts.map(account=><li key={account.id} className="min-w-0 text-sm"><p className="break-words font-medium">{account.displayName||account.handle||account.externalAccountId}</p><p className="break-all text-xs text-muted-foreground">{account.platform} · {account.handle||account.externalAccountId}</p></li>)}</ul></section>:null}
    {preview.media?.length?<section aria-label="Selected media" className="space-y-2"><h3 className="text-sm font-medium">Media</h3><ul className="space-y-2">{preview.media.map((asset,index)=><li key={`${asset.assetId}:${index}`} className="min-w-0"><p className="break-all text-sm">{asset.fileName||asset.assetId}</p>{asset.mimeType?<p className="text-xs text-muted-foreground">{asset.mimeType}</p>:null}</li>)}</ul></section>:null}
    {preview.postId?<Button asChild variant="outline" size="sm"><Link to={`/content/posts/${encodeURIComponent(preview.postId)}`}>Open post</Link></Button>:null}
  </section>;
}
function savedPostId(result:unknown):string|null {
  if(!result||typeof result!=="object"||!("post" in result)||!result.post||typeof result.post!=="object")return null;
  return "id" in result.post&&typeof result.post.id==="string"?result.post.id:null;
}
function OperationReviewContent({initial}:{initial:{review:Review|null;error:string}}) {
  const [review,setReview]=useState<Review|null>(initial.review),[error,setError]=useState(initial.error),[pending,setPending]=useState<"approve"|"reject"|null>(null);
  const rawInput=review?.input;
  const inputText=rawInput&&typeof rawInput==="object"&&"text" in rawInput&&typeof rawInput.text==="string"?rawInput.text:undefined;
  const resultPostId=savedPostId(review?.result);
  const expired=Boolean(review&&new Date(review.expiresAt).getTime()<=Date.now());
  const blocked=review?.preview?.validation?.ready===false;
  const actionable=Boolean(review&&["proposed","pending","prepared","awaiting_review"].includes(review.state)&&!expired);
  useEffect(()=>{
    if(!review||!["approved","executing","claimed"].includes(review.state))return;
    const controller=new AbortController(),deadline=new Date(review.expiresAt).getTime();
    let refreshing=false;
    const timer=window.setInterval(()=>{
      if(!Number.isFinite(deadline)||Date.now()>=deadline){
        window.clearInterval(timer);
        if(review.state==="approved")setReview(current=>current?{...current,state:"expired"}:current);
        return;
      }
      if(refreshing)return;refreshing=true;
      void fetch(`/api/operations/reviews/${encodeURIComponent(review.id)}`,{credentials:"include",cache:"no-store",signal:controller.signal}).then(async response=>{
        if(!response.ok)throw new Error("Could not refresh action status");
        const result=await response.json() as {review:Review};if(!controller.signal.aborted){setReview(result.review);setError("");}
      }).catch(caught=>{if(!controller.signal.aborted)setError(caught instanceof Error?caught.message:"Could not refresh action status");}).finally(()=>{refreshing=false;});
    },3000);
    return ()=>{window.clearInterval(timer);controller.abort();};
  },[review]);
  async function decide(decision:"approve"|"reject") {
    if(!review||pending||decision==="approve"&&blocked)return;
    setPending(decision);setError("");
    try {
      const response=await fetch(`/api/operations/reviews/${encodeURIComponent(review.id)}/decision`,{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision,payloadDigest:review.payloadDigest})});
      const payload=await response.json() as {review?:Review;error?:string;resumePending?:boolean};
      if(!response.ok||!payload.review)throw new Error(payload.error||"Could not update this review");
      setReview(payload.review);toast.success(decision==="approve"?"Action approved":"Action rejected");
    } catch(caught) {setError(caught instanceof Error?caught.message:"Could not update this review");}
    finally {setPending(null);}
  }
  return <div className="min-h-[100dvh] p-4 sm:p-6"><div className="mx-auto max-w-3xl space-y-6"><PageHeader><PageHeaderContent><PageHeaderTitle>Review action</PageHeaderTitle></PageHeaderContent>{review?<Badge variant="secondary">{expired&&["proposed","pending","prepared","awaiting_review"].includes(review.state)?"Expired":review.state.replaceAll("_"," ")}</Badge>:null}</PageHeader>{error?<p role="alert" className="text-sm text-destructive">{error}</p>:null}{review?<><section className="space-y-3"><h2 className="break-words text-base font-semibold">{operationLabels[review.operation]??review.operation.replaceAll("."," ").replaceAll("_"," ")}</h2><p className="text-xs text-muted-foreground">Expires {new Date(review.expiresAt).toLocaleString()}</p>{review.preview?<ContentPreview preview={{...review.preview,content:review.preview.content??inputText}}/>:null}<details open={!review.preview||!review.operation.startsWith("content.")} className="rounded-lg border border-border bg-card"><summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Exact request</summary><pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all border-t border-border p-4 text-xs leading-5">{JSON.stringify(review.input,null,2)}</pre></details></section>{review.state==="approved"?<p role="status" className="text-sm text-muted-foreground">Approved. Waiting for your agent.</p>:null}{review.errorCode?<p role="status" className="text-sm text-destructive">Action needs attention: {review.errorCode}</p>:null}{resultPostId&&!review.preview?.postId?<Button asChild variant="outline" size="sm"><Link to={`/content/posts/${encodeURIComponent(resultPostId)}`}>Open post</Link></Button>:null}{review.result!=null?<details className="rounded-lg border border-border bg-card"><summary className="cursor-pointer rounded-lg px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Result</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border p-4 text-xs leading-5">{JSON.stringify(review.result,null,2)}</pre></details>:null}{actionable?<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" disabled={Boolean(pending)} onClick={()=>void decide("reject")}>{pending==="reject"?"Rejecting…":"Reject"}</Button><Button type="button" disabled={Boolean(pending)||blocked} onClick={()=>void decide("approve")}>{pending==="approve"?"Approving…":"Approve action"}</Button></div>:null}{expired&&["proposed","pending","prepared","awaiting_review"].includes(review.state)?<p className="text-sm text-muted-foreground">This review expired. Ask your agent to prepare the action again.</p>:null}</>:null}<Button asChild variant="ghost"><Link to="/content">Back to content</Link></Button></div></div>;
}
