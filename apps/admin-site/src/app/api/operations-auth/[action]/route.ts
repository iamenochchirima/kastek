import {operationsAuthProxy} from "@/lib/operations-api";
type Context={params:Promise<{action:string}>};
export async function GET(request:Request,context:Context){return operationsAuthProxy(request,(await context.params).action);}
export async function POST(request:Request,context:Context){return operationsAuthProxy(request,(await context.params).action);}
