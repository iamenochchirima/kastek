import {Link} from "react-router-dom";
import {useEffect,useRef,useState} from "react";
import {Button} from "@/components/ui/button";
import {api,message,organizationPath} from "./api";
import {ErrorMessage,useWorkspace} from "./shell";
export type Enquiry={amendsEnquiryId?:string|null;id:string;taskId:string;fields:Record<string,string>;state:string;requestDigest:string;expiresAt:string;createdAt:string;submittedAt:string|null};
const labels:Record<string,string>={pending:"Confirm enquiry",approved:"Saving enquiry",submitted:"Enquiry submitted",rejected:"Declined",expired:"Confirmation expired"};
export function EnquiryConfirmations({taskId,awaiting,available,onRefresh}:{taskId:string;awaiting:boolean;available:boolean;onRefresh?:()=>void}){
 const {organizationId}=useWorkspace(),path=`${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}/enquiries`;
 const [items,setItems]=useState<Enquiry[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),lock=useRef(false);
 useEffect(()=>{
  if(!awaiting&&!available)return;
  let live=true,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{try{const result=await api<{enquiries:Enquiry[]}>(path);if(!live)return;setItems(result.enquiries.filter(item=>item.taskId===taskId));setError("");if(awaiting||result.enquiries.some(item=>["pending","approved"].includes(item.state)&&Date.parse(item.expiresAt)>Date.now()))timer=setTimeout(()=>void poll(),1200);}catch(e){if(live)setError(message(e));}};
  void poll();return()=>{live=false;clearTimeout(timer);};
 },[path,taskId,awaiting,available,revision]);
 async function decide(item:Enquiry,decision:"approve"|"reject"){
  if(lock.current)return;lock.current=true;setBusy(true);setError("");
  try{await api(`${path}/${encodeURIComponent(item.id)}/decision`,{decision,requestDigest:item.requestDigest});setRevision(value=>value+1);onRefresh?.();}catch(e){setError(message(e));}finally{lock.current=false;setBusy(false);}
 }
 if(!items.length&&!error)return null;
 return <section className="space-y-3" aria-label="Enquiry confirmation"><ErrorMessage value={error}/>{items.map(item=><article key={item.id} className="rounded-md border border-border p-4 space-y-3"><h3 className="font-medium">{item.amendsEnquiryId?"Enquiry update":"Enquiry"}</h3><dl className="space-y-2 text-sm">{Object.entries(item.fields).map(([key,value])=><div key={key}><dt className="capitalize text-muted-foreground">{key}</dt><dd className="break-words whitespace-pre-wrap">{value}</dd></div>)}</dl><p role="status" className="text-sm text-muted-foreground">{Date.parse(item.expiresAt)<=Date.now()&&item.state==="pending"?labels.expired:item.amendsEnquiryId&&item.state==="submitted"?"Enquiry updated":labels[item.state]}</p>{item.state==="pending"&&Date.parse(item.expiresAt)>Date.now()?<div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy} onClick={()=>void decide(item,"approve")}>{item.amendsEnquiryId?"Save changes":"Submit enquiry"}</Button><Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>void decide(item,"reject")}>Decline</Button></div>:null}</article>)}</section>;
}
export function ConversationEnquiries({path}:{path:string}){
 const [items,setItems]=useState<Enquiry[]>([]),[error,setError]=useState("");
 useEffect(()=>{let live=true;api<{enquiries:Enquiry[]}>(path).then(result=>{if(live){setItems(result.enquiries);setError("");}}).catch(e=>{if(live)setError(message(e));});return()=>{live=false;};},[path]);
 if(!items.length&&!error)return null;
 return <section aria-label="Submitted enquiries" className="space-y-3 my-4"><h3 className="font-medium text-sm">Enquiries</h3><ErrorMessage value={error}/>{items.map(item=><details key={item.id} className="rounded-md border p-3 text-sm"><summary className="cursor-pointer">{item.fields.name||item.fields.service||"Enquiry"} · {new Date(item.submittedAt??item.createdAt).toLocaleString()}</summary><Link className="inline-block mt-3 text-primary underline" to={`/app/customers?enquiry=${encodeURIComponent(item.id)}`}>Manage enquiry</Link><dl className="space-y-2 mt-3">{Object.entries(item.fields).map(([key,value])=><div key={key}><dt className="capitalize text-muted-foreground">{key}</dt><dd className="break-words whitespace-pre-wrap">{value}</dd></div>)}</dl></details>)}</section>;
}
