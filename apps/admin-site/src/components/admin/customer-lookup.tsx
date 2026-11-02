"use client";
import {useMemo,useState} from "react";
import {useRouter} from "next/navigation";
import {ReportCustomerSelector} from "./report-customer-selector";
import {AdminPageHeader} from "./page-header";
import type {ReportScope} from "@/lib/admin-report-format";
export function CustomerLookup(){
 const router=useRouter();
 const [product,setProduct]=useState<ReportScope["product"]>("all");
 const [dates]=useState(()=>({end:new Date().toISOString(),start:new Date(Date.now()-30*86400000).toISOString()}));
 const scope=useMemo<ReportScope>(()=>({...dates,product,timezone:"UTC",page:1,pageSize:50}),[dates,product]);
 return <div className="admin-page"><AdminPageHeader title="Customers"/><div className="grid max-w-xl gap-4 sm:grid-cols-[160px_minmax(0,1fr)]"><label className="grid gap-2 text-sm">Product<select className="h-10 rounded-md border border-input bg-background px-3" value={product} onChange={event=>setProduct(event.target.value as ReportScope["product"])}><option value="all">All products</option><option value="growth">Growth</option><option value="agents">Agents</option><option value="agency">Agency</option></select></label><div className="grid gap-2 text-sm"><span>Customer</span><ReportCustomerSelector scope={scope} onSelect={(source,id)=>{if(source!=="all"&&id)router.push(`/customers/${source}/${encodeURIComponent(id)}`);}}/></div></div></div>;
}
