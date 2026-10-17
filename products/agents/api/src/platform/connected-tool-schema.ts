import {z} from "zod";
import {PlatformError,requestDigest} from "./contracts";
import type {CapabilityBinding,ResourceHandle} from "./capability-catalog";
import type {ToolDefinition} from "./model";

export const CONNECTED_SCHEMA_RELEASE="github-handles-v1";
export type ConnectedModelArguments={repository?:string;revisionId?:string;fileId?:string;releaseId?:string;offset?:number};
const unavailable=()=>new PlatformError("CONNECTED_OPERATION_UNAVAILABLE",403,"The selected connected read operation is unavailable");
const uuid={type:"string",minLength:36,maxLength:36};
export function connectedParameters(operation:string,resources:readonly ResourceHandle[]):Record<string,unknown>{
 const repositories=resources.filter(resource=>resource.kind==="github.repository").map(resource=>resource.id).sort();
 let properties:Record<string,unknown>,required:string[];
 switch(operation){
  case"get_repository":case"list_releases":case"resolve_ref":case"get_latest_release":properties={repository:{type:"string",enum:repositories}};required=["repository"];break;
  case"list_tree":case"get_repository_tree":properties={revisionId:uuid,offset:{type:"integer",minimum:0,maximum:1999}};required=["revisionId"];break;
  case"read_file":case"get_file_contents":properties={fileId:uuid,offset:{type:"integer",minimum:0,maximum:1048576}};required=["fileId"];break;
  case"get_release_by_tag":properties={releaseId:uuid};required=["releaseId"];break;
  default:throw unavailable();
 }
 return{type:"object",properties,required,additionalProperties:false};
}
export function connectedModelArguments(binding:CapabilityBinding,input:unknown):ConnectedModelArguments{
 const repository=z.enum(binding.resources.filter(resource=>resource.kind==="github.repository").map(resource=>resource.id) as [string,...string[]]);
 switch(binding.definition.providerOperation){
  case"get_repository":case"list_releases":case"resolve_ref":case"get_latest_release":return z.strictObject({repository}).parse(input);
  case"list_tree":case"get_repository_tree":return z.strictObject({revisionId:z.uuid(),offset:z.number().int().min(0).max(1999).optional()}).parse(input);
  case"read_file":case"get_file_contents":return z.strictObject({fileId:z.uuid(),offset:z.number().int().min(0).max(1048576).optional()}).parse(input);
  case"get_release_by_tag":return z.strictObject({releaseId:z.uuid()}).parse(input);
  default:throw unavailable();
 }
}
const descriptions:Record<string,string>={get_repository:"Read metadata for an approved public repository.",list_releases:"List one bounded page of public releases; returned release handles can be inspected with the selected release tool.",resolve_ref:"Resolve the owner's approved repository revision to an immutable commit; returns a revisionId.",list_tree:"List files at an issued immutable revisionId; returns fileId handles.",read_file:"Read a bounded text passage from an issued fileId. offset is a UTF-16 character offset.",get_repository_tree:"Read a public repository tree using a revisionId issued by the selected native resolve_ref tool.",get_file_contents:"Read a bounded text passage using a fileId issued by the selected native list_tree tool.",get_latest_release:"Read the latest public release of an approved repository.",get_release_by_tag:"Read a public release using a releaseId issued by the selected list_releases tool."};
export function connectedModelTool(binding:CapabilityBinding):ToolDefinition{
 return{type:"function",function:{name:binding.alias,description:descriptions[binding.definition.providerOperation]??unavailable().message,parameters:connectedParameters(binding.definition.providerOperation,binding.resources)}};
}
export function assertConnectedBindingDependencies(bindings:readonly CapabilityBinding[]):void{
 for(const binding of bindings){
  if(binding.transport!=="mcp_http")continue;
  const required=binding.definition.providerOperation==="get_repository_tree"?["resolve_ref"]:binding.definition.providerOperation==="get_file_contents"?["resolve_ref","list_tree"]:binding.definition.providerOperation==="get_release_by_tag"?["list_releases"]:[];
  for(const operation of required)for(const resource of binding.resources){
   if(!bindings.some(candidate=>candidate.transport==="native_http"&&candidate.connection?.id===binding.connection?.id&&candidate.definition.providerOperation===operation&&candidate.resources.some(selected=>requestDigest(selected)===requestDigest(resource))))throw new PlatformError("CONNECTED_HANDLE_DEPENDENCY",400,`Select native ${operation} for each repository used by ${binding.definition.providerOperation}`);
  }
 }
}
