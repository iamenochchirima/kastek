import {createHash} from 'node:crypto';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Ajv2020} from 'ajv/dist/2020.js';
import * as formatsPlugin from 'ajv-formats';
import {parseDocument} from 'yaml';
import {canonicalJson,parseSerdeValueJson,SerdeFloat} from '@kasitek-labs/server-support/json';
import type {ContractSummary,DimensionDefinition,MetricDefinition,MetricSetDefinition,RegistrySnapshot} from './registry-types.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const contractsRoot=join(root,'contracts'),metricsRoot=join(root,'metrics');
const ajv=new Ajv2020({allErrors:true,strict:false,validateFormats:true});
const addFormats=(formatsPlugin as unknown as {default:(instance:Ajv2020)=>void}).default;
addFormats(ajv);
const compiledSchemas=new Map<string,{fingerprint:string;validate:ReturnType<typeof ajv.compile>}>();
export class RegistryError extends Error {constructor(message:string){super(message);this.name='RegistryError';}}
const safePath=(base:string,path:string):string=>{
 if(!path||path.startsWith('/')||path.split(/[\\/]/).some(part=>part==='..'||part===''))throw new RegistryError(`invalid registry source path ${path}`);
 const full=resolve(base,path),rel=relative(base,full);
 if(rel==='..'||rel.startsWith(`..${sep}`)||resolve(full)!==full)throw new RegistryError(`registry source escapes its directory: ${path}`);
 return full;
};
const readJson=async(path:string):Promise<unknown>=>{const raw=await readFile(path,'utf8');try{return parseSerdeValueJson(raw);}catch(error){throw new RegistryError(`failed to parse JSON registry file ${relative(root,path)}: ${error instanceof Error?error.message:'invalid JSON'}`);}};
function compileSchema(path:string,schema:unknown){
 const id=(schema as {$id?:string})?.$id,key=id?`id:${id}`:resolve(path),fingerprint=canonicalJson(schema),cached=compiledSchemas.get(key);
 if(cached?.fingerprint===fingerprint)return cached.validate;
 if(cached&&id)ajv.removeSchema(id);
 try{const validate=ajv.compile(forSchema(schema) as object);compiledSchemas.set(key,{fingerprint,validate});return validate;}
 catch(error){throw new RegistryError(`registry schema compilation failed for ${relative(root,path)}: ${error instanceof Error?error.message:'invalid schema'}`);}
}
function validateValue(path:string,schema:unknown,value:unknown):void {
 const check=compileSchema(path,schema),normalized=forSchema(value);
 if(check(normalized))return;
 const issue=check.errors?.[0];throw new RegistryError(`registry validation failed for ${relative(root,path)}: ${issue?.instancePath||'/'} ${issue?.message??'invalid value'}`);
}
function forSchema(value:unknown):unknown {
 if(value instanceof SerdeFloat)return value.value;
 if(typeof value==='bigint')return Number(value);
 if(Array.isArray(value))return value.map(forSchema);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,forSchema(item)]));
 return value;
}
function normalizeYaml(value:unknown):unknown {
 if(typeof value==='bigint')return value<=BigInt(Number.MAX_SAFE_INTEGER)&&value>=BigInt(Number.MIN_SAFE_INTEGER)?Number(value):value;
 if(Array.isArray(value))return value.map(normalizeYaml);
 if(value&&typeof value==='object'&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalizeYaml(item)]));
 return value;
}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const unique=(values:string[],description:string)=>{if(new Set(values).size!==values.length)throw new RegistryError(`registry identity conflict: duplicate ${description}`);};
const lexical=(left:string,right:string)=>left<right?-1:left>right?1:0;
const metricIdentity=(value:Pick<MetricDefinition,'key'|'version'>)=>`${value.key}@${value.version}`;
const metricSetIdentity=(value:Pick<MetricSetDefinition,'key'|'version'>)=>`${value.key}@${value.version}`;
function validateContractIdentities(contracts:Pick<ContractSummary,'identity'>[]):void {
 const identities=new Set<string>();
 for(const contract of contracts){if(identities.has(contract.identity))throw new RegistryError(`registry identity conflict: duplicate contract identity ${contract.identity}`);identities.add(contract.identity);}
}
export function validateRegistrySemantics(metrics:MetricDefinition[],dimensions:DimensionDefinition[],sets:MetricSetDefinition[],contracts:ContractSummary[]):void {
 validateContractIdentities(contracts);
 const contractKeys=new Set(contracts.map(item=>item.identity)),metricKeys=new Set(metrics.map(metricIdentity)),dimensionKeys=new Set(dimensions.map(item=>item.key));
 const seenMetrics=new Set<string>(),seenSets=new Set<string>();
 const graph=new Map<string,string[]>();
 for(const metric of metrics){const identity=metricIdentity(metric);
  if(seenMetrics.has(identity))throw new RegistryError(`registry identity conflict: duplicate metric identity ${identity}`);
  seenMetrics.add(identity);
  if(metric.sources.some(source=>!contractKeys.has(source)))throw new RegistryError(`registry identity conflict: metric ${identity} references an unregistered source contract`);
  if(metric.dimensions.some(key=>!dimensionKeys.has(key)))throw new RegistryError(`registry identity conflict: metric ${identity} references an unknown dimension`);
  if(metric.coverage.required_sources.some(source=>!metric.sources.includes(source)))throw new RegistryError(`registry identity conflict: metric ${identity} coverage references a source outside its source set`);
  if((metric.value_type==='percentage'||metric.default_aggregation==='ratio_of_sums')&&(metric.numerator===null||metric.denominator===null))throw new RegistryError(`registry validation failed for ${identity}: ratio metrics require numerator and denominator`);
  if(metric.numerator!==null&&!metric.dependencies.includes(metric.numerator))throw new RegistryError(`registry identity conflict: metric ${identity} numerator ${metric.numerator} is not declared as a dependency`);
  if(metric.denominator!==null&&!metric.dependencies.includes(metric.denominator))throw new RegistryError(`registry identity conflict: metric ${identity} denominator ${metric.denominator} is not declared as a dependency`);
  for(const dependency of metric.dependencies)if(!metricKeys.has(dependency))throw new RegistryError(`registry identity conflict: metric ${identity} references unknown dependency ${dependency}`);
  graph.set(identity,metric.dependencies);
 }
 const visited=new Set<string>(),visiting=new Set<string>();
 const visit=(key:string)=>{if(visited.has(key))return;if(visiting.has(key))throw new RegistryError(`registry dependency cycle: ${key}`);visiting.add(key);for(const dependency of graph.get(key)??[])visit(dependency);visiting.delete(key);visited.add(key);};
 for(const key of graph.keys())visit(key);
 for(const dimension of dimensions)for(const identity of dimension.compatible_metrics){const metric=metrics.find(item=>metricIdentity(item)===identity);if(!metric)throw new RegistryError(`registry identity conflict: dimension ${dimension.key} references unknown metric ${identity}`);if(!metric.dimensions.includes(dimension.key))throw new RegistryError(`registry identity conflict: dimension ${dimension.key} is compatible with metric ${identity} but the metric does not declare it`);}
 for(const set of sets){const identity=metricSetIdentity(set);if(seenSets.has(identity))throw new RegistryError(`registry identity conflict: duplicate metric-set identity ${identity}`);seenSets.add(identity);if(set.metrics.some(metric=>!metricKeys.has(metric)))throw new RegistryError(`registry identity conflict: metric set ${identity} references an unknown metric`);}
}
const renderTuple=(name:string,values:string[])=>`export const ${name} = [\n${values.map(value=>`  ${JSON.stringify(value)},\n`).join('')}] as const;\n\n`;
export function renderTypescriptBindings(registry:RegistrySnapshot):string {
 const contracts=[...registry.contracts].map(item=>item.identity),metrics=registry.metrics.map(metricIdentity),dimensions=registry.dimensions.map(item=>item.key),sets=registry.metric_sets.map(metricSetIdentity);
 return `// @generated by analytics-registry; do not edit.\n\nexport const ANALYTICS_REGISTRY_VERSION = ${JSON.stringify(registry.metrics_registry_version)} as const;\nexport const ANALYTICS_REGISTRY_SHA256 = ${JSON.stringify(registry.sha256)} as const;\n\n`+renderTuple('ANALYTICS_CONTRACT_KEYS',contracts)+renderTuple('ANALYTICS_METRIC_KEYS',metrics)+renderTuple('ANALYTICS_DIMENSION_KEYS',dimensions)+renderTuple('ANALYTICS_METRIC_SET_KEYS',sets)+`\nexport type AnalyticsContractKey = (typeof ANALYTICS_CONTRACT_KEYS)[number];\nexport type AnalyticsMetricKey = (typeof ANALYTICS_METRIC_KEYS)[number];\nexport type AnalyticsDimensionKey = (typeof ANALYTICS_DIMENSION_KEYS)[number];\nexport type AnalyticsMetricSetKey = (typeof ANALYTICS_METRIC_SET_KEYS)[number];\n`;
}
export async function checkGeneratedBindings(registry:RegistrySnapshot):Promise<void>{
 const path=join(root,'generated_registry.ts'),current=await readFile(path,'utf8'),expected=renderTypescriptBindings(registry);
 if(current!==expected)throw new RegistryError('generated analytics TypeScript bindings are stale: services/analytics/generated_registry.ts');
}
export async function writeGeneratedBindings(registry:RegistrySnapshot):Promise<void>{await writeFile(join(root,'generated_registry.ts'),renderTypescriptBindings(registry));}

export async function loadRegistry():Promise<RegistrySnapshot>{
 const contractRegistryPath=join(contractsRoot,'registry.json'),contractRegistry=await readJson(contractRegistryPath) as {registry_version:string;envelope:string;contracts:{identity:string;schema:string;examples:string[];owner:string;category:string;privacy_class:string}[]};
 const contractRegistrySchema=await readJson(join(contractsRoot,'registry.schema.json'));
 validateValue(join(contractsRoot,'registry.schema.json'),contractRegistrySchema,contractRegistry);
 if(contractRegistry.envelope!=='envelope.schema.json')throw new RegistryError(`contract registry envelope must be envelope.schema.json, got ${contractRegistry.envelope}`);
 const envelopePath=join(contractsRoot,'envelope.schema.json'),envelopeSchema=await readJson(envelopePath);compileSchema(envelopePath,envelopeSchema);
 validateValue(envelopePath,envelopeSchema,await readJson(join(contractsRoot,'examples/envelope.json')));
 validateContractIdentities(contractRegistry.contracts);
 const indexedSchemas=new Set<string>(),contracts:ContractSummary[]=[];
 for(const entry of contractRegistry.contracts){
  const schemaPath=safePath(contractsRoot,entry.schema),schema=await readJson(schemaPath);indexedSchemas.add(resolve(schemaPath));
  compileSchema(schemaPath,schema);
  const meta=(schema as {['x-kasitek']?:Record<string,unknown>})['x-kasitek'];
  if(!meta||meta.identity!==entry.identity||meta.owner!==entry.owner||meta.privacy_class!==entry.privacy_class)throw new RegistryError(`registry metadata does not match ${entry.identity}`);
  const prohibited=Array.isArray(meta.prohibited_fields)?meta.prohibited_fields.filter((field):field is string=>typeof field==='string'):[];
  const properties=(schema as {properties?:Record<string,unknown>}).properties??{};
  for(const field of prohibited)if(Object.hasOwn(properties,field))throw new RegistryError(`prohibited field ${field} is declared as a property in ${entry.schema}`);
  for(const example of entry.examples){const examplePath=safePath(contractsRoot,example);validateValue(examplePath,schema,await readJson(examplePath));}
  contracts.push({identity:entry.identity,owner:entry.owner,category:entry.category,privacy_class:entry.privacy_class,schema_sha256:sha(canonicalJson(schema))});
 }
 const actualSchemas=(await readdir(join(contractsRoot,'events'),{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()&&entry.name.endsWith('.schema.json'));
 for(const entry of actualSchemas){const abs=resolve(join(entry.parentPath,entry.name));if(!indexedSchemas.has(abs))throw new RegistryError(`registry source file is not indexed: ${relative(contractsRoot,abs)}`);}
 contracts.sort((a,b)=>lexical(a.identity,b.identity));

 const indexPath=join(metricsRoot,'index.json'),index=await readJson(indexPath) as {registry_version:string;files:string[]};
 validateValue(join(metricsRoot,'index.schema.json'),await readJson(join(metricsRoot,'index.schema.json')),index);
 const metricsSchema=await readJson(join(metricsRoot,'registry.schema.json'));compileSchema(join(metricsRoot,'registry.schema.json'),metricsSchema);
 unique(index.files,'metrics registry source path');
 const indexedFiles=new Set<string>(),metrics:MetricDefinition[]=[],dimensions:DimensionDefinition[]=[],metricSets:MetricSetDefinition[]=[];
 for(const path of index.files){const file=safePath(metricsRoot,path);indexedFiles.add(resolve(file));const doc=parseDocument(await readFile(file,'utf8'),{intAsBigInt:true,uniqueKeys:true});if(doc.errors.length)throw new RegistryError(`failed to parse YAML registry file ${path}: ${doc.errors[0]?.message}`);const value=normalizeYaml(doc.toJS()) as {kind?:string;definitions?:unknown[]};
  validateValue(file,metricsSchema,value);
  if(!Array.isArray(value.definitions))throw new RegistryError(`definitions must be an array in ${path}`);
  if(value.kind==='metrics')metrics.push(...value.definitions.map(item=>{
   const raw=item as MetricDefinition;
   return {...raw,precision:raw.precision??null,numerator:raw.numerator??null,denominator:raw.denominator??null,applicability:raw.applicability??null,replacement:raw.replacement??null};
  }));
  else if(value.kind==='dimensions')dimensions.push(...value.definitions.map(item=>{const raw=item as Record<string,unknown>;return {...raw,value_type:raw.type} as unknown as DimensionDefinition;}));
  else if(value.kind==='metric_sets')metricSets.push(...value.definitions.map(item=>item as MetricSetDefinition));
  else throw new RegistryError(`unsupported registry source kind ${String(value.kind)}`);
 }
 const metricFiles=(await readdir(metricsRoot,{recursive:true,withFileTypes:true})).filter(entry=>entry.isFile()&&/\.ya?ml$/.test(entry.name));
 for(const entry of metricFiles){const abs=resolve(join(entry.parentPath,entry.name));if(!indexedFiles.has(abs))throw new RegistryError(`registry source file is not indexed: ${relative(metricsRoot,abs)}`);}
 metrics.sort((a,b)=>lexical(metricIdentity(a),metricIdentity(b)));dimensions.sort((a,b)=>lexical(a.key,b.key));metricSets.sort((a,b)=>lexical(metricSetIdentity(a),metricSetIdentity(b)));
 validateRegistrySemantics(metrics,dimensions,metricSets,contracts);
 const artifact={contract_registry_version:contractRegistry.registry_version,metrics_registry_version:index.registry_version,contracts,metrics,dimensions:dimensions.map(item=>({key:item.key,type:item.value_type,source:item.source,compatible_metrics:item.compatible_metrics,filterable:item.filterable,groupable:item.groupable,cardinality:item.cardinality,privacy_class:item.privacy_class,stable_key:item.stable_key,permissions:item.permissions})),metric_sets:metricSets};
 const registry:RegistrySnapshot={contract_registry_version:contractRegistry.registry_version,metrics_registry_version:index.registry_version,contracts,metrics,dimensions,metric_sets:metricSets,sha256:sha(canonicalJson(artifact))};
 await prepareValidators();
 return registry;
}

const validators=new Map<string,ReturnType<typeof compileSchema>>();
export function validateEnvelope(value:unknown):void {
 const key='envelope';let check=validators.get(key);
 if(!check)throw new Error('analytics registry validators have not been loaded');
 if(!check(forSchema(value)))throw new Error(check.errors?.[0]?.message??'invalid envelope');
}
export function validateRegisteredContract(identity:string,value:unknown):void {
 let check=validators.get(identity);
 if(!check)throw new Error(`contract ${identity} is not registered`);
 if(!check(forSchema(value)))throw new Error(check.errors?.[0]?.message??'invalid contract payload');
}
export async function prepareValidators():Promise<void>{
 const registry=await readJson(join(contractsRoot,'registry.json')) as {contracts:{identity:string;schema:string}[]};
 for(const entry of registry.contracts){const path=safePath(contractsRoot,entry.schema),schema=await readJson(path);validators.set(entry.identity,compileSchema(path,schema));}
 const path=join(contractsRoot,'envelope.schema.json');validators.set('envelope',compileSchema(path,await readJson(path)));
}
