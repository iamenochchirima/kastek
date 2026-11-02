import fs from "node:fs";
import {createHash} from "node:crypto";
const LIMIT={raw:10485760,text:1048576,pages:200,chunks:1000,batch:16,output:8388608};
const sha=value=>createHash("sha256").update(value).digest("hex");
const invalid=code=>{const error=new Error(code);error.code=code;throw error;};
const normalize=text=>text.normalize("NFC").replace(/\r\n?/g,"\n");
const withinText=text=>{if(Buffer.byteLength(text)>LIMIT.text)invalid("DOCUMENT_TEXT_LIMIT");if(text.includes("\0"))invalid("DOCUMENT_INVALID");return text;};
async function parse(input){
 const bytes=fs.readFileSync("/input/document.bin");if(!bytes.length||bytes.length>LIMIT.raw)invalid("DOCUMENT_INPUT_LIMIT");
 let values=[];
 if(input.format==="text"||input.format==="markdown")values=[new TextDecoder("utf-8",{fatal:true}).decode(bytes)];
 else if(input.format==="html"){
  const {JSDOM}=await import("jsdom"),{Readability}=await import("@mozilla/readability");
  const html=new TextDecoder("utf-8",{fatal:true}).decode(bytes);
  const dom=new JSDOM(html,{url:"https://source.invalid/",contentType:"text/html"});
  try{const article=new Readability(dom.window.document,{maxElemsToParse:200000,charThreshold:20}).parse();if(!article?.textContent?.trim())invalid("DOCUMENT_NO_TEXT");
   const clean=new JSDOM(article.content);try{let text="";const blocks=new Set(["P","DIV","SECTION","ARTICLE","H1","H2","H3","H4","H5","H6","LI","TR","BLOCKQUOTE","PRE"]);
    const walk=node=>{if(node.nodeType===3){text+=node.nodeValue;return;}if(node.nodeType!==1)return;const block=blocks.has(node.tagName);if(block||node.tagName==="BR")text+="\n";for(const child of node.childNodes)walk(child);if(block)text+="\n";if(node.tagName==="TD"||node.tagName==="TH")text+="\t";if(Buffer.byteLength(text)>LIMIT.text)invalid("DOCUMENT_TEXT_LIMIT");};
    walk(clean.window.document.body);values=[text.replace(/\n{3,}/g,"\n\n").trim()];
   }finally{clean.window.close();}
  }finally{dom.window.close();}
 }else if(input.format==="pdf"){
  const pdfjs=await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading=pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0,isEvalSupported:false,enableXfa:false,disableFontFace:true,useSystemFonts:false,useWasm:false,stopAtErrors:true,disableAutoFetch:true,disableStream:true});
  let document;
  try{document=await loading.promise;if(document.numPages>LIMIT.pages)invalid("DOCUMENT_PAGE_LIMIT");let total=0;
   for(let page=1;page<=document.numPages;page++){const item=await document.getPage(page),content=await item.getTextContent();let text="";
    for(const token of content.items){if(typeof token.str==="string")text+=token.str+(token.hasEOL?"\n":" ");if(Buffer.byteLength(text)>LIMIT.text)invalid("DOCUMENT_TEXT_LIMIT");}
    text=text.trim();total+=Buffer.byteLength(text)+2;if(total>LIMIT.text)invalid("DOCUMENT_TEXT_LIMIT");values.push(text);item.cleanup();
   }
  }catch(error){if(error.name==="PasswordException")invalid("DOCUMENT_ENCRYPTED");throw error;}finally{await loading.destroy();}
 }else invalid("DOCUMENT_UNSUPPORTED");
 let offset=0;const pages=values.map((raw,index)=>{const text=withinText(normalize(raw)),page={page:index+1,start:offset,end:offset+text.length,text};offset=page.end+2;return page;});
 const text=withinText(pages.map(page=>page.text).join("\n\n"));if(!text.trim())invalid("DOCUMENT_NO_TEXT");
 return{kind:"parse",text,textDigest:sha(text),pages,offsetEncoding:"utf16"};
}
async function tokenizer(){const {Tokenizer}=await import("@huggingface/tokenizers");return new Tokenizer(JSON.parse(fs.readFileSync("/model/tokenizer.json","utf8")),JSON.parse(fs.readFileSync("/model/tokenizer_config.json","utf8")));}
function validatePages(pages){
 if(!Array.isArray(pages)||!pages.length||pages.length>LIMIT.pages)invalid("DOCUMENT_PAGE_LIMIT");let offset=0,total=0;
 for(const [index,page]of pages.entries()){
  if(page.page!==index+1||typeof page.text!=="string"||page.start!==offset||page.end!==offset+page.text.length)invalid("DOCUMENT_SPAN_INVALID");
  withinText(page.text);total+=Buffer.byteLength(page.text)+2;if(total>LIMIT.text+2)invalid("DOCUMENT_TEXT_LIMIT");offset=page.end+2;
 }
}
async function chunk(input){
 validatePages(input.pages);const max=input.maxTokens??384,overlap=input.overlap??48;if(max!==384||overlap!==48)invalid("EMBEDDING_PROFILE_INVALID");
 const tok=await tokenizer(),chunks=[];
 for(const page of input.pages){const chars=Array.from(page.text),offsets=[0];for(const char of chars)offsets.push(offsets.at(-1)+char.length);let start=0;
  const count=(left,right,special=true)=>tok.encode(page.text.slice(offsets[left],offsets[right]),{add_special_tokens:special}).ids.length;
  while(start<chars.length){let lo=start+1,hi=Math.min(chars.length,start+8192),end=start;
   while(lo<=hi){const mid=Math.floor((lo+hi)/2);if(count(start,mid)<=max){end=mid;lo=mid+1;}else hi=mid-1;}
   if(end<=start)invalid("EMBEDDING_TOKEN_LIMIT");const text=page.text.slice(offsets[start],offsets[end]);
   if(text.trim()){if(chunks.length>=LIMIT.chunks)invalid("DOCUMENT_CHUNK_LIMIT");chunks.push({page:page.page,start:page.start+offsets[start],end:page.start+offsets[end],text,tokenCount:count(start,end)});}
   if(end===chars.length)break;
   let left=start+1,right=end,next=end;
   while(left<=right){const mid=Math.floor((left+right)/2);if(count(mid,end,false)<=overlap){next=mid;right=mid-1;}else left=mid+1;}
   start=Math.max(start+1,next);
  }
 }
 if(!chunks.length)invalid("DOCUMENT_NO_TEXT");return{kind:"chunk",chunks,offsetEncoding:"utf16",maxTokens:max,overlap};
}
async function embed(input){
 if(!["query","document"].includes(input.mode)||!Array.isArray(input.texts)||!input.texts.length||input.texts.length>LIMIT.batch)invalid("EMBEDDING_BATCH_LIMIT");
 let bytes=0;for(const text of input.texts){if(typeof text!=="string"||!text.trim()||(bytes+=Buffer.byteLength(text))>131072)invalid("EMBEDDING_INPUT_LIMIT");}
 const tok=await tokenizer(),encoded=input.texts.map(text=>tok.encode((input.mode==="query"?"Represent this sentence for searching relevant passages: ":"")+text));
 if(encoded.some(value=>value.ids.length>(input.mode==="document"?384:512)))invalid("EMBEDDING_TOKEN_LIMIT");
 const ort=await import("onnxruntime-node");ort.env.logLevel="error";
 const session=await ort.InferenceSession.create("/model/onnx/model.onnx",{executionProviders:["cpu"],intraOpNumThreads:1,interOpNumThreads:1,executionMode:"sequential",graphOptimizationLevel:"all",logSeverityLevel:3});
 const vectors=[];
 try{for(const value of encoded){const count=value.ids.length,feeds={};for(const name of session.inputNames)feeds[name]=new ort.Tensor("int64",BigInt64Array.from(name==="input_ids"?value.ids:name==="attention_mask"?value.attention_mask:Array(count).fill(0),BigInt),[1,count]);
   const output=await session.run(feeds),tensor=output.last_hidden_state;if(!tensor||tensor.dims[0]!==1||tensor.dims[1]!==count||tensor.dims[2]!==384)invalid("EMBEDDING_OUTPUT_INVALID");
   const cls=Array.from(tensor.data.slice(0,384)),norm=Math.hypot(...cls);if(!Number.isFinite(norm)||norm===0||cls.some(x=>!Number.isFinite(x)))invalid("EMBEDDING_OUTPUT_INVALID");vectors.push(cls.map(x=>x/norm));
  }
 }finally{await session.release();}
 return{kind:"embed",vectors,tokenCounts:encoded.map(x=>x.ids.length),dimensions:384,pooling:"cls",normalization:"l2",mode:input.mode};
}
// Libraries receive untrusted bytes; only bounded typed results leave the guest.
console.log=()=>{};console.warn=()=>{};
let output;
try{const raw=fs.readFileSync("/input/request.json");if(raw.length>15000000)invalid("DOCUMENT_INPUT_LIMIT");const input=JSON.parse(raw);output={ok:true,result:input.kind==="parse"?await parse(input):input.kind==="chunk"?await chunk(input):input.kind==="embed"?await embed(input):invalid("DOCUMENT_UNSUPPORTED")};}
catch(error){output={ok:false,errorCode:typeof error.code==="string"&&/^(DOCUMENT_|EMBEDDING_)[A-Z_]+$/.test(error.code)?error.code:"DOCUMENT_INVALID"};}
const encoded=JSON.stringify(output);if(Buffer.byteLength(encoded)>LIMIT.output)process.stdout.write(JSON.stringify({ok:false,errorCode:"DOCUMENT_OUTPUT_LIMIT"}));else process.stdout.write(encoded);
