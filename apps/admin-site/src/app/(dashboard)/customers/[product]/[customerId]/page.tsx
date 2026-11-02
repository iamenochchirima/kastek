import {notFound} from "next/navigation";
import {adminCapabilities} from "@kasitek-labs/server-support/admin-authority";
import {requireAdminSession} from "@/lib/admin-auth";
import {CustomerWorkspace} from "@/components/admin/customer-workspace";
import type {CustomerProduct} from "@kasitek-labs/contracts";
export default async function CustomerPage({params}:{params:Promise<{product:string;customerId:string}>}) {
 const {product,customerId}=await params;
 if(!["growth","agents","agency"].includes(product))notFound();
 const actor=await requireAdminSession();
 return <CustomerWorkspace product={product as CustomerProduct} customerId={customerId} canOperate={adminCapabilities(actor.role).has("admin:operate")} />;
}
