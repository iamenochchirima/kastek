import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {githubMcpFileText,githubMcpFileUri} from "../src/adapters/providers/github-mcp-file";
import type {GithubFileHandle,GithubRevision} from "../src/adapters/providers/github-adapter";
const text="Unicode 🧪 and exact bytes.\n",bytes=Buffer.from(text),revision={repository:{owner:"Owner",repository:"repo",ref:"main"},commitSha:"a".repeat(40)} as GithubRevision;
const file={path:"docs/a !'()*.md",size:bytes.length,blobSha:createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")} as GithubFileHandle;
const resource=()=>({type:"resource",resource:{uri:githubMcpFileUri(revision,file),mimeType:"text/markdown; charset=utf-8",text}});
describe("GitHub inline MCP immutable file normalizer",()=>{
 it("matches official segment encoding and returns only verified UTF8 file bytes",()=>{
  expect(githubMcpFileUri(revision,file)).toBe(`repo://Owner/repo/sha/${revision.commitSha}/contents/docs/a%20%21%27%28%29%2A.md`);
  expect(githubMcpFileText({content:[{type:"text",text:"untrusted provider status"},resource()]},revision,file)).toBe(text);
 });
 it.each([
  ["query",()=>({...resource(),resource:{...resource().resource,uri:githubMcpFileUri(revision,file)+"?secret=1"}}),"MCP_FILE_IDENTITY_MISMATCH"],
  ["path",()=>({...resource(),resource:{...resource().resource,uri:githubMcpFileUri(revision,{...file,path:"other.md"})}}),"MCP_FILE_IDENTITY_MISMATCH"],
  ["same byte length forged body",()=>({...resource(),resource:{...resource().resource,text:text.replace("exact","wrong")}}),"MCP_FILE_CONTENT_MISMATCH"],
  ["unpaired surrogate",()=>({...resource(),resource:{...resource().resource,text:"\ud800"}}),"MCP_FILE_CONTENT_MISMATCH"],
  ["mixed blob/text",()=>({...resource(),resource:{...resource().resource,blob:"Yg=="}}),"MCP_FILE_BINARY_UNSUPPORTED"],
  ["nontext MIME",()=>({...resource(),resource:{...resource().resource,mimeType:"image/png"}}),"MCP_FILE_BINARY_UNSUPPORTED"],
 ] as const)("rejects %s",(_name,block,code)=>{expect(()=>githubMcpFileText({content:[block()]},revision,file)).toThrow(expect.objectContaining({code}));});
 it("rejects ambiguous multiple resources and provider error results",()=>{
  expect(()=>githubMcpFileText({content:[resource(),resource()]},revision,file)).toThrow(expect.objectContaining({code:"MCP_FILE_UNAVAILABLE"}));
  expect(()=>githubMcpFileText({isError:true,content:[resource()]},revision,file)).toThrow(expect.objectContaining({code:"MCP_FILE_UNAVAILABLE"}));
 });
});
