import {randomUUID} from "node:crypto";
import {readFile,stat,writeFile,rm,mkdtemp,mkdir} from "node:fs/promises";
import {join,resolve} from "node:path";
import {homedir,tmpdir} from "node:os";
import {createServer} from "node:http";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {DocumentRuntime,type DocumentInput,type DocumentOutput} from "../src/capabilities/knowledge/document-runtime";

const suite=process.env.AGENTS_DOCUMENT_RUNTIME_VERIFY==="1"?describe:describe.skip;
suite("real pinned no-network document and embedding resources",()=>{
 const cache=process.env.AGENTS_DOCUMENT_RUNTIME_CACHE??join(homedir(),".cache/kasitek-documents");
 const runtime=new DocumentRuntime({cache}),allocated=new Set<string>();let release:string;
 beforeAll(async()=>{expect(await runtime.available()).toBe(true);release=(await runtime.profile()).profileRelease;});
 afterAll(async()=>{for(const id of allocated)await runtime.destroy(id);});
 async function run(input:DocumentInput){
  const allocationId=randomUUID();allocated.add(allocationId);
  const request={allocationId,jobId:randomUUID(),profileRelease:release,input};await runtime.start(request);
  const result=await finish(allocationId);return{allocationId,request,result};
 }
 async function finish(id:string){
  for(let count=0;count<700;count++){
   const state=await runtime.status(id);if(state.state==="failed"||state.state==="completed"){
    const result=await runtime.result(id);expect(result).toBeDefined();expect(result!.receipt.memoryPeakBytes).toBeLessThanOrEqual(536870912);return result!;
   }
   if(state.state!=="running"&&state.state!=="prepared")throw Error(JSON.stringify(state));
   await new Promise(done=>setTimeout(done,100));
  }throw Error("Document resource did not finish");
 }
 function success(output:Awaited<ReturnType<typeof run>>["result"]):DocumentOutput {if(!output.ok)throw Error(output.errorCode);return output.result;}
 function pdf(pages:string[]){
  const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_,i)=>`${3+i*2} 0 R`).join(" ")}] >>`];
  const fontId=3+pages.length*2;
  for(const [index,text]of pages.entries()){
   const content=`BT /F1 12 Tf 40 750 Td (${text.replace(/[()\\]/g,"\\$&")}) Tj ET`;
   objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4+index*2} 0 R >>`,`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");let body="%PDF-1.4\n",offsets=[0];
  for(const [index,object]of objects.entries()){offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(body);
 }
 it("extracts page provenance and normalized UTF16 spans, rejects invalid and empty documents",async()=>{
  const parsed=success((await run({kind:"parse",format:"pdf",content:pdf(["Welcome to the service.","Booking information.","Cancellations within fourteen days cost forty-two dollars."])})).result);
  expect(parsed.kind).toBe("parse");if(parsed.kind!=="parse")return;
  expect(parsed.pages).toHaveLength(3);expect(parsed.pages[2]!.text).toContain("forty-two dollars");
  for(const page of parsed.pages)expect(parsed.text.slice(page.start,page.end)).toBe(page.text);
  const unicode=success((await run({kind:"parse",format:"text",content:Buffer.from("Cafe\u0301 😀\r\nBooking policies")})).result);
  expect(unicode.kind==="parse"&&unicode.text).toBe("Café 😀\nBooking policies");
  const invalid=await run({kind:"parse",format:"text",content:Buffer.from([0xff,0xfe])});expect(invalid.result).toMatchObject({ok:false,errorCode:"DOCUMENT_INVALID"});
  const blank=await run({kind:"parse",format:"pdf",content:pdf([""])});expect(blank.result).toMatchObject({ok:false,errorCode:"DOCUMENT_NO_TEXT"});
  const oversize=Buffer.alloc(10485761);await expect(runtime.start({allocationId:randomUUID(),jobId:randomUUID(),profileRelease:release,input:{kind:"parse",format:"text",content:oversize}})).rejects.toMatchObject({code:"DOCUMENT_INPUT_LIMIT"});
 },30_000);
 it("extracts static HTML without running scripts or loading resources",async()=>{
  let requests=0;const server=createServer((_request,response)=>{requests++;response.end("secret");});await new Promise<void>(done=>server.listen(0,"0.0.0.0",done));
  try{const address=server.address() as {port:number};const html=`<html><head><title>Cancellation policy</title><script>fetch('http://127.0.0.1:${address.port}/leak')</script></head><body><article><h1>Cancellation policy</h1><p>Bookings cancelled within fourteen days cost forty-two dollars. This is the cancellation policy for all bookings.</p><p>Contact support for further assistance and help with your booking cancellation.</p><img src="http://127.0.0.1:${address.port}/image"></article></body></html>`;
   const output=success((await run({kind:"parse",format:"html",content:Buffer.from(html)})).result);expect(output.kind==="parse"&&output.text).toContain("forty-two dollars");expect(output.kind==="parse"&&output.text).not.toContain("fetch(");expect(requests).toBe(0);
  }finally{await new Promise<void>(done=>server.close(()=>done()));}
 },15_000);
 it("chunks actual tokenizer bounds with overlapping Unicode source spans and embeds meaningful paraphrases",async()=>{
  const text=("Café 😀 cancellation policy states fourteen days and forty-two dollars. ").repeat(100);
  const chunks=success((await run({kind:"chunk",pages:[{page:1,start:0,end:text.length,text}]})).result);expect(chunks.kind).toBe("chunk");if(chunks.kind!=="chunk")return;
  expect(chunks.chunks.length).toBeGreaterThan(2);
  for(const [index,chunk]of chunks.chunks.entries()){expect(text.slice(chunk.start,chunk.end)).toBe(chunk.text);expect(chunk.tokenCount).toBeLessThanOrEqual(384);if(index>0){expect(chunk.start).toBeLessThan(chunks.chunks[index-1]!.end);expect(chunk.start).toBeGreaterThan(chunks.chunks[index-1]!.start);}}
  const documents=success((await run({kind:"embed",mode:"document",texts:["Bookings cancelled within fourteen days cost forty-two dollars.","The office walls are blue and the coffee machine is downstairs."]})).result);
  const query=success((await run({kind:"embed",mode:"query",texts:["How much is the fee if I cancel my reservation two weeks before?"]})).result);
  expect(documents.kind).toBe("embed");expect(query.kind).toBe("embed");if(documents.kind!=="embed"||query.kind!=="embed")return;
  const dot=(a:number[],b:number[])=>a.reduce((total,value,index)=>total+value*b[index]!,0),scores=documents.vectors.map(vector=>dot(query.vectors[0]!,vector));
  expect(scores[0]!-scores[1]!).toBeGreaterThan(.25);expect(documents.vectors[0]).toHaveLength(384);expect(Math.hypot(...documents.vectors[0]!)).toBeCloseTo(1,5);
  const bounded=success((await run({kind:"embed",mode:"document",texts:chunks.chunks.slice(0,16).map(chunk=>chunk.text)})).result);expect(bounded.kind==="embed"&&bounded.vectors.length).toBe(chunks.chunks.slice(0,16).length);
  const overflow=await run({kind:"embed",mode:"document",texts:["cancellation ".repeat(600)]});expect(overflow.result).toMatchObject({ok:false,errorCode:"EMBEDDING_TOKEN_LIMIT"});
 },60_000);
 it("reattaches after caller death without rerunning and honors pinned helpers rather than current pointer",async()=>{
  const allocationId=randomUUID(),jobId=randomUUID();allocated.add(allocationId);
  const script=`const {DocumentRuntime}=require('./src/capabilities/knowledge/document-runtime');(async()=>{const r=new DocumentRuntime({cache:${JSON.stringify(cache)}});await r.start({allocationId:${JSON.stringify(allocationId)},jobId:${JSON.stringify(jobId)},profileRelease:${JSON.stringify(release)},input:{kind:'embed',mode:'document',texts:Array(16).fill('cancellation '.repeat(380))}});console.log('launched');setInterval(()=>{},10000)})().catch(e=>{console.error(e.code);process.exit(1)})`;
  const child=spawn(process.execPath,["--import","tsx","-e",script],{cwd:process.cwd(),stdio:["ignore","pipe","pipe"]});await new Promise<void>((resolve,reject)=>{child.stdout.on("data",()=>resolve());child.on("error",reject);child.on("exit",code=>{if(code!==null)reject(Error("Caller exited before resource launch"));});});child.kill("SIGKILL");
  const before=await finish(allocationId),resource=join(cache,"resources",allocationId,"output.json"),timestamp=(await stat(resource)).mtimeMs;
  const pointer=join(cache,"current-profile.json"),previous=await readFile(pointer,"utf8");
  try{await writeFile(pointer,JSON.stringify({profileRelease:"document-processing-v1@"+"0".repeat(64)}));const reopened=new DocumentRuntime({cache});expect(await reopened.result(allocationId)).toEqual(before);await reopened.start({allocationId,jobId,profileRelease:release,input:{kind:"embed",mode:"document",texts:Array(16).fill("cancellation ".repeat(380))}});expect((await stat(resource)).mtimeMs).toBe(timestamp);}
  finally{await writeFile(pointer,previous);}
  await expect(runtime.start({allocationId,jobId,profileRelease:release,input:{kind:"parse",format:"text",content:Buffer.from("Different input")}})).rejects.toMatchObject({code:"DOCUMENT_RESOURCE_CONFLICT"});
 },30_000);
 it("fences destroy before start and stops running allocations without a late physical launch",async()=>{
  const id=randomUUID();allocated.add(id);await runtime.destroy(id);
  await expect(runtime.start({allocationId:id,jobId:randomUUID(),profileRelease:release,input:{kind:"parse",format:"text",content:Buffer.from("Never starts")}})).rejects.toMatchObject({code:"DOCUMENT_RESOURCE_EXPIRED"});
  const active=randomUUID();allocated.add(active);await runtime.start({allocationId:active,jobId:randomUUID(),profileRelease:release,input:{kind:"embed",mode:"document",texts:Array(16).fill("cancellation ".repeat(380))}});
  expect((await runtime.destroy(active)).state).toBe("destroyed");expect((await runtime.status(active)).state).toBe("destroyed");expect(await runtime.result(active)).toBeUndefined();await expect(stat(join(cache,"resources",active))).rejects.toMatchObject({code:"ENOENT"});
 },15_000);
 it("binds rootfs image provenance and refuses a cache containing an unrelated Node binary",async()=>{
  const profile=await runtime.profile(),artifact=profile.identity.rootfsArtifact as {image:string;manifestDigest:string;nodeSHA256:string};
  expect(artifact.nodeSHA256).toMatch(/^[a-f0-9]{64}$/);expect(profile.rootfs).toContain(`/rootfs/${artifact.manifestDigest.slice(7)}/canonical-tar-v1/rootfs`);
  const helper=resolve(__dirname,"../../../../infra/agents-runtime/document-rootfs.py"),execute=promisify(execFile);
  expect((await execute("python3",[helper,cache,artifact.image])).stdout.trim()).toBe(profile.rootfs);
  const isolated=await mkdtemp(join(tmpdir(),"document-provenance-")),directory=join(isolated,"rootfs",artifact.manifestDigest.slice(7),"canonical-tar-v1");
  try{
   await mkdir(join(directory,"rootfs/usr/local/bin"),{recursive:true});await writeFile(join(directory,"rootfs/usr/local/bin/node"),"unrelated cached binary");
   await writeFile(join(directory,"provenance.json"),JSON.stringify({...artifact,image:"unrelated-image"}));
   await expect(execute("python3",[helper,isolated,artifact.image])).rejects.toMatchObject({stderr:expect.stringContaining("provenance mismatch")});
   await writeFile(join(directory,"provenance.json"),JSON.stringify(artifact));await expect(execute("python3",[helper,isolated,artifact.image])).rejects.toMatchObject({stderr:expect.stringContaining("provenance mismatch")});
  }finally{await rm(isolated,{recursive:true,force:true});}
 },15_000);
});
