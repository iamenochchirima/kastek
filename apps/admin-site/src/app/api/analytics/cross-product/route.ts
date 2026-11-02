import {crossProductReport,reportError} from "@/lib/cross-product-reporting";
export async function GET(request:Request){try{return Response.json(await crossProductReport(request),{headers:{"Cache-Control":"no-store"}});}catch(error){return reportError(error);}}
