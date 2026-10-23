import {operationsApi} from "@/lib/operations-api";
type Context={params:Promise<{path:string[]}>};
const serve=async(request:Request,context:Context)=>operationsApi(request,"/"+(await context.params).path.join("/"));
export const GET=serve;
export const POST=serve;
export const PUT=serve;
