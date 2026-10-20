import { z } from "zod";
import type { CapabilityBinding,ResourceHandle } from "../../contracts/capability-catalog";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import type { ToolDefinition } from "../../execution/business/model";
import { genericConnectedArguments } from "./generic-connected-runtime";

export const CONNECTED_SCHEMA_RELEASE="connected-handles-v3";
export type ConnectedModelArguments={ [key:string]:unknown;repository?:string;revisionId?:string;fileId?:string;releaseId?:string;itemId?:string;filePath?:string;maxBytes?:number;offset?:number};
const unavailable=()=>new PlatformError("CONNECTED_OPERATION_UNAVAILABLE",403,"The selected connected read operation is unavailable");
const uuid={type:"string",minLength:36,maxLength:36};
export function connectedParameters(operation:string,resources:readonly ResourceHandle[]):Record<string,unknown>{
 const repositories=resources.filter(resource=>resource.kind==="github.repository").map(resource=>resource.id).sort();
 let properties:Record<string,unknown>,required:string[];
 switch(operation){
  case"read_wiki_structure":case"read_wiki_contents":case"get_repository":case"list_releases":case"resolve_ref":case"get_latest_release":properties={repository:{type:"string",enum:repositories}};required=["repository"];if(["read_wiki_structure","read_wiki_contents"].includes(operation))properties.offset={type:"integer",minimum:0,maximum:262144};break;
  case"list_tree":properties={revisionId:uuid,filePath:{type:"string",minLength:1,maxLength:1024},offset:{type:"integer",minimum:0,maximum:1999}};required=["revisionId"];break;
  case"get_repository_tree":properties={revisionId:uuid,offset:{type:"integer",minimum:0,maximum:1999}};required=["revisionId"];break;
  case"read_file":properties={fileId:uuid,offset:{type:"integer",minimum:0,maximum:1048576},maxBytes:{type:"integer",minimum:128,maximum:4096}};required=["fileId"];break;
  case"get_file_contents":properties={fileId:uuid,offset:{type:"integer",minimum:0,maximum:1048576}};required=["fileId"];break;
  case"get_release_by_tag":properties={releaseId:uuid};required=["releaseId"];break;
  case"get_item":case"read_project_document":properties={itemId:{type:"string",enum:resources.filter(resource=>resource.kind==="stash.item").map(resource=>resource.id).sort()},offset:{type:"integer",minimum:0,maximum:operation==="get_item"?49999:500000}};required=["itemId"];break;
  default:throw unavailable();
 }
 return{type:"object",properties,required,additionalProperties:false};
}
export function connectedModelArguments(binding:CapabilityBinding,input:unknown):ConnectedModelArguments{
 if(binding.connection?.profileId==="remote-mcp-v1")return genericConnectedArguments(input);
 if(binding.connection?.profileId==="stash-read-v1"){
  if(binding.transport!=="mcp_http"||!["get_item","read_project_document"].includes(binding.definition.providerOperation))throw unavailable();
  return z.strictObject({itemId:z.uuid().refine(id=>binding.resources.some(resource=>resource.kind==="stash.item"&&resource.id===id)),offset:z.number().int().min(0).max(binding.definition.providerOperation==="get_item"?49999:500000).optional()}).parse(input);
 }
 const repository=z.enum(binding.resources.filter(resource=>resource.kind==="github.repository").map(resource=>resource.id) as [string,...string[]]);
 switch(binding.definition.providerOperation){
  case"read_wiki_structure":case"read_wiki_contents":return z.strictObject({repository,offset:z.number().int().min(0).max(262144).optional()}).parse(input);
  case"get_repository":case"list_releases":case"resolve_ref":case"get_latest_release":return z.strictObject({repository}).parse(input);
  case"list_tree":return z.strictObject({revisionId:z.uuid(),filePath:z.string().min(1).max(1024).optional(),offset:z.number().int().min(0).max(1999).optional()}).parse(input);
  case"get_repository_tree":return z.strictObject({revisionId:z.uuid(),offset:z.number().int().min(0).max(1999).optional()}).parse(input);
  case"read_file":return z.strictObject({fileId:z.uuid(),offset:z.number().int().min(0).max(1048576).optional(),maxBytes:z.number().int().min(128).max(4096).optional()}).parse(input);
  case"get_file_contents":return z.strictObject({fileId:z.uuid(),offset:z.number().int().min(0).max(1048576).optional()}).parse(input);
  case"get_release_by_tag":return z.strictObject({releaseId:z.uuid()}).parse(input);
  default:throw unavailable();
 }
}
const descriptions:Record<string,string>={read_wiki_structure:"Read the public DeepWiki documentation structure for an approved repository. This is a timestamped provider observation, not a commit snapshot.",read_wiki_contents:"Read bounded public DeepWiki documentation for an approved repository. offset is a UTF-16 character offset. Large provider responses fail explicitly.",get_item:"Read an explicitly approved Stash note or idea. offset is a UTF-16 character offset within the first 50000 characters. Follow nextOffset, using read_project_document for a longer project document.",read_project_document:"Read a bounded passage of an approved Stash project note or idea at a UTF-16 offset. Follow observation.provenance.nextOffset for continuation.",get_repository:"Read metadata for an approved public repository.",list_releases:"List one bounded page of public releases; returned release handles can be inspected with the selected release tool.",resolve_ref:"Resolve the owner's approved repository revision to an immutable commit; returns a revisionId.",list_tree:"List files at an issued immutable revisionId and return fileId handles. Use filePath to select an exact known path locally, such as README.md; it is never sent to the provider. Omit filePath to browse bounded pages.",read_file:"Read verified text from an issued fileId. offset is a UTF-16 character offset; optional maxBytes selects 128–4096 bytes locally and defaults to 4096. If truncated, advance offset by the returned text length.",get_repository_tree:"Read a public repository tree using a revisionId issued by the selected native resolve_ref tool.",get_file_contents:"Read a bounded text passage using a fileId issued by the selected native list_tree tool.",get_latest_release:"Read the latest public release of an approved repository.",get_release_by_tag:"Read a public release using a releaseId issued by the selected list_releases tool."};
export function connectedModelTool(binding:CapabilityBinding):ToolDefinition{
 if(binding.connection?.profileId==="remote-mcp-v1")return{type:"function",function:{name:binding.alias,
  description:`${binding.policy.effect==="reviewed_write"?"Requires exact approval for each invocation. ":"Owner-reviewed remote operation. "}${binding.definition.description}`,
  parameters:binding.definition.inputSchema as Record<string,unknown>}};
 return{type:"function",function:{name:binding.alias,description:descriptions[binding.definition.providerOperation]??unavailable().message,parameters:connectedParameters(binding.definition.providerOperation,binding.resources)}};
}
export function assertConnectedBindingDependencies(bindings:readonly CapabilityBinding[]):void{
 for(const binding of bindings){
  if(binding.connection?.profileId==="remote-mcp-v1")continue;
  if(binding.transport!=="mcp_http")continue;
  const required=binding.definition.providerOperation==="get_repository_tree"?["resolve_ref"]:binding.definition.providerOperation==="get_file_contents"?["resolve_ref","list_tree"]:binding.definition.providerOperation==="get_release_by_tag"?["list_releases"]:[];
  for(const operation of required)for(const resource of binding.resources){
   if(!bindings.some(candidate=>candidate.transport==="native_http"&&candidate.connection?.id===binding.connection?.id&&candidate.definition.providerOperation===operation&&candidate.resources.some(selected=>requestDigest(selected)===requestDigest(resource))))throw new PlatformError("CONNECTED_HANDLE_DEPENDENCY",400,`Select native ${operation} for each repository used by ${binding.definition.providerOperation}`);
  }
 }
}
