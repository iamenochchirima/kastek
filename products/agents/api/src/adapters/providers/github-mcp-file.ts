import { createHash } from "node:crypto";
import { PlatformError } from "../../contracts/contracts";
import { GITHUB_LIMITS,type GithubFileHandle,type GithubRevision } from "./github-adapter";

const invalid=(code:string)=>new PlatformError(code,502,"The MCP file response did not match the authorized immutable file");
// GitHub e3809fe91c7546633241006bf0b91f23b2595e28 repository_resource.go
// expands a pinned ref with segment escaping. Its status text names a blob SHA, not this commit.
const segment=(value:string)=>encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export function githubMcpFileUri(revision:GithubRevision,file:GithubFileHandle):string{
 return `repo://${segment(revision.repository.owner)}/${segment(revision.repository.repository)}/sha/${revision.commitSha}/contents/${file.path.split("/").map(segment).join("/")}`;
}
export function githubMcpFileText(raw:Record<string,unknown>,revision:GithubRevision,file:GithubFileHandle):string{
 if(raw.isError===true)throw invalid("MCP_FILE_UNAVAILABLE");
 const content=raw.content;
 if(!Array.isArray(content)||content.length>100)throw invalid("MCP_FILE_UNAVAILABLE");
 if(content.some(item=>item?.type==="resource_link"))throw invalid("MCP_FILE_LINK_UNSUPPORTED");
 const resources=content.filter(item=>item?.type==="resource");
 if(resources.length!==1||content.some(item=>!["text","resource"].includes(item?.type)))throw invalid("MCP_FILE_UNAVAILABLE");
 const resource=resources[0].resource;
 if(!resource||typeof resource!=="object"||resource.uri!==githubMcpFileUri(revision,file))throw invalid("MCP_FILE_IDENTITY_MISMATCH");
 if("blob" in resource)throw invalid("MCP_FILE_BINARY_UNSUPPORTED");
 const mime=typeof resource.mimeType==="string"?resource.mimeType.split(";",1)[0].trim().toLowerCase():"";
 if(!(mime.startsWith("text/")||["application/json","application/xml"].includes(mime)||/^[a-z0-9.+-]+\/[a-z0-9.+-]+\+(json|xml)$/.test(mime)))throw invalid("MCP_FILE_BINARY_UNSUPPORTED");
 if(typeof resource.text!=="string"||resource.text.includes("\0"))throw invalid("MCP_FILE_UNAVAILABLE");
 const bytes=Buffer.from(resource.text,"utf8");
 if(bytes.length>GITHUB_LIMITS.fileBytes||bytes.length!==file.size||bytes.toString("utf8")!==resource.text)throw invalid("MCP_FILE_CONTENT_MISMATCH");
 const blob=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
 if(blob!==file.blobSha)throw invalid("MCP_FILE_CONTENT_MISMATCH");
 return resource.text;
}
