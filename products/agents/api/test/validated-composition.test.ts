import {randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {agentConfigurationSchema,canonicalJson,defaultBusinessConfiguration,requestDigest} from '../src/contracts/contracts';
import {createBinding,createCatalog,digestToolSchema,capabilityBindingSchema} from '../src/contracts/capability-catalog';
import {REPORT_WORKFLOW_BINDING} from '../src/capabilities/tool-descriptors';
import {resolveProgram} from '../src/execution/programs/composition';
import {compilePublishedComposition} from '../src/execution/programs/publication';
import {createValidatedCompositionCompiler} from '../src/execution/lifecycle/validated-composition';
import {publishedToolBindings} from '../src/capabilities/tool-definitions';
import {PROTOCOL_TOOL_NAMES,protocolToolVersions,protocolToolBindings} from '../src/capabilities/protocol-tools';
import {historyToolDefinitions} from '../src/capabilities/history-tools';
import {validateBuiltinArguments} from '../src/capabilities/tool-contracts';

function binding(){
 const organizationId=randomUUID(),connectionId=randomUUID(),inputSchema={type:'object',properties:{},additionalProperties:false};
 const adapter={id:'fixture-read',release:'1',manifestDigest:'a'.repeat(64)};
 const catalog=createCatalog({schemaVersion:1,id:randomUUID(),organizationId,connectionId,revision:1,transport:'native_http',protocolVersion:null,adapter,
  tools:[{providerOperation:'read',description:'Read fixture',inputSchema,inputDigest:digestToolSchema(inputSchema),outputSchema:null,outputDigest:null}]});
 return createBinding({schemaVersion:1,id:randomUUID(),organizationId,catalog:{id:catalog.id,revision:1,digest:catalog.digest},definition:catalog.tools[0]!,adapter,transport:'native_http',protocolVersion:null,
  connection:{id:connectionId,profileId:'fixture-read-v1',policyRevision:1},resources:[{kind:'repository',id:'approved/repo'}],
  policy:{effect:'read',disclosure:'public_identifiers',retry:'safe_read',approval:'none',cancel:'stop_admission'},
  limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxResponseBytes:8192,maxModelResultBytes:8192}},catalog);
}
describe('validated pure compilation cache',()=>{
 it('reuses only exact content and preserves uncached composition digests',()=>{
  const compiler=vi.fn(compilePublishedComposition),compile=createValidatedCompositionCompiler(compiler),config=defaultBusinessConfiguration();
  const first=compile(config,[]);expect(first).toEqual(compilePublishedComposition(config,[]));
  expect(compile(structuredClone(config),[])).toBe(first);expect(compiler).toHaveBeenCalledTimes(1);
  config.instructions+=' Different private canary instructions';const next=compile(config,[]);
  expect(next.digest).not.toBe(first.digest);expect(compiler).toHaveBeenCalledTimes(2);
  const connected=binding();config.connectedToolBindingIds=[connected.id];compile(config,[connected]);
  const changed=structuredClone(connected);changed.limits.timeoutMs=29000;const {digest,...content}=changed;changed.digest=requestDigest(content);
  compile(config,[capabilityBindingSchema.parse(changed)]);expect(compiler).toHaveBeenCalledTimes(4);
  // Even a stale declared digest must not be used as the content key.
  const forged={...changed,digest:connected.digest};expect(()=>compile(config,[forged])).toThrow('Binding digest mismatch');expect(compiler).toHaveBeenCalledTimes(5);
 });
 it('distinguishes optional own undefined content from an absent field',()=>{
  const source=defaultBusinessConfiguration();source.tools=['agents.delegate'];source.capabilities.delegation={enabled:true,maxChildren:2,maxDepth:1,
   bindings:[{id:'specialist',versionId:randomUUID(),sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000}]};
  const absent=agentConfigurationSchema.parse(source),withUndefined=structuredClone(absent);
  if(!withUndefined.capabilities.delegation.enabled)throw Error('Fixture delegation required');withUndefined.capabilities.delegation.bindings[0]!.label=undefined;
  const present=agentConfigurationSchema.parse(withUndefined),compiler=vi.fn(compilePublishedComposition),compile=createValidatedCompositionCompiler(compiler);
  expect(JSON.stringify(absent)).toBe(JSON.stringify(present));
  expect(compile(absent,[]).configurationDigest).not.toBe(compile(present,[]).configurationDigest);expect(compiler).toHaveBeenCalledTimes(2);
 });
 it('pins fresh protocol schemas and preserves prior schema choices without sharing cache entries',()=>{
  const config=defaultBusinessConfiguration();config.memory={enabled:true};config.tools=['memory.search','memory.propose'];
  const oldPins=publishedToolBindings(config,false,new Map([['memory.search','2'],['memory.read','1'],['memory.propose','1']]));
  const freshPins=publishedToolBindings(config),compiler=vi.fn(compilePublishedComposition),compile=createValidatedCompositionCompiler(compiler);
  const original=compile(config,[],oldPins),fresh=compile(config,[],freshPins);
  expect(original.capabilities.some(binding=>(PROTOCOL_TOOL_NAMES as readonly string[]).includes(binding.id))).toBe(false);
  expect(fresh.capabilities.filter(binding=>(PROTOCOL_TOOL_NAMES as readonly string[]).includes(binding.id))).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'tools.discover',version:'3'}),expect.objectContaining({id:'history.read',version:'2'}),
    expect.objectContaining({id:'history.search',version:'2'}),
  ]));
  expect(original.capabilities.find(binding=>binding.id==='memory.search')!.version).toBe('2');
  expect(original.digest).not.toBe(fresh.digest);
  expect(compile(config,[],structuredClone(oldPins))).toBe(original);expect(compiler).toHaveBeenCalledTimes(2);
  const oldVersions=protocolToolVersions(oldPins);
  expect(oldVersions.get('history.read')).toBe('1');
  expect(historyToolDefinitions(oldVersions).find(tool=>tool.function.name==='history_read')!.function.parameters.properties).not.toHaveProperty('artifactId');
  const input={taskId:randomUUID(),artifactId:randomUUID(),part:'artifact'};
  expect(()=>validateBuiltinArguments('history.read',input,'1')).toThrow('capability contract');
  expect(()=>validateBuiltinArguments('history.read',input,'2')).not.toThrow();
  const artifactSearch={part:'artifacts',beforeArtifactId:randomUUID()};
  expect(()=>validateBuiltinArguments('history.search',artifactSearch,'1')).toThrow('capability contract');
  expect(()=>validateBuiltinArguments('history.search',artifactSearch,'2')).not.toThrow();
  expect(historyToolDefinitions(oldVersions).find(tool=>tool.function.name==='history_search')!.function.parameters.properties).not.toHaveProperty('beforeArtifactId');
  expect(protocolToolBindings(new Map(PROTOCOL_TOOL_NAMES.map(name=>[name,'1']))).find(binding=>binding.name==='history.search')!.digest)
    .toBe('65beac207bf12ce5ff5591f9c44d585de15755f57fb530ab6f487466cdf64d45');
 });
 it('does not cache failures or expose private input through new error wrapping',()=>{
  const compiler=vi.fn(()=>{throw Error('Compilation failed');}),compile=createValidatedCompositionCompiler(compiler),config=defaultBusinessConfiguration();
  config.instructions='PRIVATE_cache_error_canary';
  for(let n=0;n<2;n++)expect(()=>compile(config,[])).toThrow(/^Compilation failed$/);
  expect(compiler).toHaveBeenCalledTimes(2);
 });
 it('isolates cached results from caller and compiler mutation and freezes static nested dependencies',()=>{
  const config=defaultBusinessConfiguration(),result=compilePublishedComposition(config,[]),compile=createValidatedCompositionCompiler(()=>result);
  const cached=compile(config,[]);result.runtime.release='mutated external result';
  expect(cached.runtime.release).not.toBe(result.runtime.release);
  expect(()=>{cached.runtime.release='poison';}).toThrow();expect(()=>cached.capabilities.push({id:'invented',version:'1',digest:'a'.repeat(64)})).toThrow();
  expect(compile(config,[])).toBe(cached);
  for(const id of ['grounded-conversation','tool-directed'] as const){const program=resolveProgram({id,version:'1'});expect(Object.isFrozen(program.allowedTools)).toBe(true);expect(Object.isFrozen(program.workflows)).toBe(true);expect(()=>{(program.allowedTools as string[]).push('invented');}).toThrow();}
  expect(Object.isFrozen(REPORT_WORKFLOW_BINDING.stages)).toBe(true);expect(Object.isFrozen(REPORT_WORKFLOW_BINDING.inputSchema.properties.connectionId)).toBe(true);
  expect(()=>{REPORT_WORKFLOW_BINDING.stages.push('invented');}).toThrow();
 });
 it('evicts least recently used entries at the entry bound',()=>{
  const compiler=vi.fn(compilePublishedComposition),limits={maxEntries:2,maxBytes:100000},compile=createValidatedCompositionCompiler(compiler,limits),a=defaultBusinessConfiguration(),b={...a,instructions:'B'},c={...a,instructions:'C'};
  compile(a,[]);compile(b,[]);compile(a,[]);limits.maxEntries=100;compile(c,[]);compile(a,[]);expect(compiler).toHaveBeenCalledTimes(3);compile(b,[]);expect(compiler).toHaveBeenCalledTimes(4);
 });
 it('bounds total serialized bytes and bypasses oversized entries',()=>{
  const config=defaultBusinessConfiguration(),compiler=vi.fn(compilePublishedComposition),first=compilePublishedComposition(config,[]);
  // Enough for one entry, including its full content key, but not two.
  const maxBytes=Buffer.byteLength(canonicalJson(["a".repeat(64),config,[]]))+Buffer.byteLength(JSON.stringify(first))+100;
  const compile=createValidatedCompositionCompiler(compiler,{maxEntries:100,maxBytes});
  compile(config,[]);compile(config,[]);expect(compiler).toHaveBeenCalledTimes(1);
  const next={...config,instructions:'Another configuration'};compile(next,[]);compile(config,[]);expect(compiler).toHaveBeenCalledTimes(3);
  const bypass=createValidatedCompositionCompiler(compiler,{maxEntries:100,maxBytes:1});bypass(config,[]);bypass(config,[]);expect(compiler).toHaveBeenCalledTimes(5);
 });
});
