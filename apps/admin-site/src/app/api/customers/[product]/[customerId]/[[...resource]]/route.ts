import {customerProxy} from "@/lib/customer-operations";
type Context={params:Promise<{product:string;customerId:string;resource?:string[]}>};
export async function GET(request:Request,context:Context){return customerProxy(request,await context.params);}
export async function POST(request:Request,context:Context){return customerProxy(request,await context.params);}
