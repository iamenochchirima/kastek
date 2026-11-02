import type {CapabilityBinding} from "../../contracts/capability-catalog";
import {canonicalJson,requestDigest,type AgentConfiguration} from "../../contracts/contracts";
import {HARNESS_RELEASE,WORKFLOW_NAME} from "../../contracts/execution";
import type {EffectiveComposition} from "../../contracts/programs";
import {BUILTIN_MODEL_ALIASES} from "../../capabilities/tool-definitions";
import {REPORT_WORKFLOW_BINDING,toolDescriptor} from "../../capabilities/tool-descriptors";
import {resolveProgram} from "../programs/composition";
import {compilePublishedComposition} from "../programs/publication";

const compilerIdentity=requestDigest({compiler:"published-composition-v1",runtime:{release:HARNESS_RELEASE,workflow:WORKFLOW_NAME},
 programs:[resolveProgram({id:"grounded-conversation",version:"1"}),resolveProgram({id:"tool-directed",version:"1"}),resolveProgram({id:"tool-directed",version:"3"}),resolveProgram({id:"tool-directed",version:"4"})],
 tools:[...Object.values(BUILTIN_MODEL_ALIASES),"knowledge.initial","report.deliver"].map(name=>toolDescriptor(name)),workflow:REPORT_WORKFLOW_BINDING});

function immutableJson<T>(value:T):T {
 if(value!==null&&typeof value==="object"){for(const child of Object.values(value))immutableJson(child);Object.freeze(value);}
 return value;
}

// Called only after fresh SQL and schema validation. Keys contain private content and never leave memory.
export function createValidatedCompositionCompiler(compile=compilePublishedComposition,limits={maxEntries:128,maxBytes:4*1024*1024}) {
 if(!Number.isSafeInteger(limits.maxEntries)||limits.maxEntries<1||!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1)throw Error("Invalid composition cache bounds");
 const {maxEntries,maxBytes}=limits;
 const entries=new Map<string,{value:EffectiveComposition;bytes:number}>();let bytes=0;
 return(configuration:AgentConfiguration,bindings:readonly CapabilityBinding[]):EffectiveComposition=>{
  const key=canonicalJson([compilerIdentity,configuration,bindings]);
  const prior=entries.get(key);
  if(prior){entries.delete(key);entries.set(key,prior);return prior.value;}
  const value=immutableJson(structuredClone(compile(configuration,bindings)));
  const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(value));
  if(size>maxBytes)return value;
  while(entries.size>=maxEntries||bytes+size>maxBytes){
   const oldest=entries.keys().next().value!;bytes-=entries.get(oldest)!.bytes;entries.delete(oldest);
  }
  entries.set(key,{value,bytes:size});bytes+=size;return value;
 };
}

export const compileValidatedComposition=createValidatedCompositionCompiler();
