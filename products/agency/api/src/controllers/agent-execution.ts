import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgencyAgentContractError, parseAgencyAgentCommand, type GrowthAgentArtifact } from "@kasitek-labs/contracts";
import type { TenantContext } from "../context.js";
import { extractTenantUserSession, requireTenantRoles } from "../middleware.js";
import { bad, TenantError } from "../error.js";
import { agencyActorIssuer, authorizeAgencyExecution } from "../capabilities/execution-authority.js";
import { agencyExecutionClient } from "../capabilities/execution-client.js";
import { ensureAgencyClientExecution } from "../capabilities/execution-setup.js";

export function registerAgentExecutionRoutes(app:FastifyInstance,context:TenantContext):void {
  async function scope(request:FastifyRequest){
    const session=await extractTenantUserSession(request,context),clientId=(request.params as {id:string}).id;
    const scope={tenantId:session.workspace_id,clientId,actor:{issuer:agencyActorIssuer(context),subject:session.tenant_user_id}};
    const authorized=await authorizeAgencyExecution(context,scope);return {...scope,roles:session.roles,clientName:authorized.clientName};
  }
  app.get("/api/clients/:id/agent",async request=>{
    const {roles,clientName,...s}=await scope(request);await ensureAgencyClientExecution(context,s.tenantId,s.clientId,s.actor.subject);
    const result=await agencyExecutionClient(context).execute({version:"1",requestId:randomUUID(),...s,operation:"readiness.get",input:{}});
    return {...result as Record<string,unknown>,client:{id:s.clientId,name:clientName},canConfigureModel:roles.some(role=>["owner","admin"].includes(role))&&!!context.config.env.AGENCY_AGENTS_CONTROL_PRIVATE_KEY};
  });
  app.post("/api/clients/:id/agent/commands",{bodyLimit:65536},async request=>{
    const {roles:_roles,clientName:_clientName,...s}=await scope(request),body=request.body as {operation?:unknown;input?:unknown;requestId?:unknown};
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["operation","input","requestId"].includes(key))||body.operation==="tenant.ensure")throw bad("invalid agent command");
    let command;try{command=parseAgencyAgentCommand({version:"1",...s,requestId:body.requestId,operation:body.operation,input:body.input});}
    catch(error){if(error instanceof AgencyAgentContractError)throw bad("invalid agent command");throw error;}
    await ensureAgencyClientExecution(context,s.tenantId,s.clientId,s.actor.subject);
    const response=await agencyExecutionClient(context).execute(command);
    request.log.info({event:"agent.execution.command",product:"agencies",workspace_id:s.tenantId,client_id:s.clientId,request_id:command.requestId,operation:command.operation},"Agent command");
    return response;
  });
  app.get("/api/clients/:id/agent/tasks/:taskId/artifacts/:artifactId/download",async (request,reply)=>{
    const {roles:_roles,clientName:_clientName,...s}=await scope(request);
    const params=request.params as {taskId:string;artifactId:string};
    const query=request.query as Record<string,unknown>;
    if(Object.keys(query).some(key=>key!=="childTaskId")||query.childTaskId!==undefined&&typeof query.childTaskId!=="string")throw bad("invalid artifact request");
    const command=(offset:number)=>{
      try{return parseAgencyAgentCommand({version:"1",...s,requestId:randomUUID(),operation:"artifacts.get",input:{taskId:params.taskId,artifactId:params.artifactId,offset,...(query.childTaskId===undefined?{}:{childTaskId:query.childTaskId})}});}
      catch(error){if(error instanceof AgencyAgentContractError)throw bad("invalid artifact request");throw error;}
    };
    await ensureAgencyClientExecution(context,s.tenantId,s.clientId,s.actor.subject);
    const chunks:Buffer[]=[];let offset=0,digest:string|undefined,bytes:number|undefined,mediaType:string|undefined,name:string|undefined;
    do{
      const result=await agencyExecutionClient(context).execute(command(offset)) as {artifact?:GrowthAgentArtifact}|null;
      if(!result||typeof result!=="object"||!result.artifact||result.artifact.id!==params.artifactId)throw new TenantError(502,"Artifact is unavailable");
      const part=result.artifact.chunk;
      if(!part||part.offset!==offset||!Number.isSafeInteger(part.bytes)||part.bytes<0||part.bytes>1048576||
        typeof part.digest!=="string"||!/^[a-f0-9]{64}$/.test(part.digest)||typeof part.base64!=="string"||part.base64.length>87384||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.base64)||
        typeof result.artifact.mediaType!=="string"||!["text/plain","text/markdown","application/json"].includes(result.artifact.mediaType)||
        typeof result.artifact.title!=="string"||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(result.artifact.title)||
        digest!==undefined&&(digest!==part.digest||bytes!==part.bytes||mediaType!==result.artifact.mediaType||name!==result.artifact.title))
        throw new TenantError(502,"Artifact is unavailable");
      digest=part.digest;bytes=part.bytes;mediaType=result.artifact.mediaType;name=result.artifact.title;
      const chunk=Buffer.from(part.base64,"base64"),end=offset+chunk.length;
      if(chunk.length>65536||end>bytes||part.nextOffset!==(end<bytes?end:null)||end===offset&&end!==bytes)
        throw new TenantError(502,"Artifact is unavailable");
      chunks.push(chunk);offset=end;if(part.nextOffset===null)break;
    }while(true);
    const content=Buffer.concat(chunks);
    if(content.length!==bytes||createHash("sha256").update(content).digest("hex")!==digest)throw new TenantError(502,"Artifact is unavailable");
    await scope(request);
    reply.header("Cache-Control","no-store").header("X-Content-Type-Options","nosniff")
      .header("Content-Disposition",`attachment; filename="${name}"`);
    return reply.type(mediaType!).send(content);
  });
  app.post("/api/clients/:id/agent/model",{bodyLimit:32768},async request=>{
    const {roles,clientName:_clientName,...s}=await scope(request);requireTenantRoles(roles,["owner","admin"]);
    const input=request.body as {requestId:string;providerId:string;modelId:string;apiKey:string;endpoint?:string};
    if(!input||typeof input!=="object"||Object.keys(input).some(key=>!["requestId","providerId","modelId","apiKey","endpoint"].includes(key))||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)||typeof input.providerId!=="string"||!input.providerId||input.providerId.length>64||
      typeof input.modelId!=="string"||!input.modelId||input.modelId.length>256||typeof input.apiKey!=="string"||input.apiKey.length<8||input.apiKey.length>8192||
      input.endpoint!==undefined&&(typeof input.endpoint!=="string"||input.endpoint.length>2048))throw bad("invalid model configuration");
    await ensureAgencyClientExecution(context,s.tenantId,s.clientId,s.actor.subject);
    const {requestId,...configuration}=input;
    return agencyExecutionClient(context).configureModel({version:"1",operation:"model.configure",requestId,...s,input:configuration});
  });
}
