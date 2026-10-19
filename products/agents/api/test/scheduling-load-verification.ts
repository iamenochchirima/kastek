export interface PhysicalModelCall {id:string;worker:string;bodyDigest:string;startedAt:number;endedAt?:number;status:number;operationId?:string;attemptId?:string;taskId?:string;rootTaskId?:string;attributionCount?:number}
export interface NativeModelCall {operationId:string;attemptId:string;taskId:string;rootTaskId:string;bodyDigest:string;state:string;errorCode:string|null;providerRequestId?:string}
export interface EffectIdentity {id:string;taskId:string;rootTaskId:string;nativeRootTaskId:string;artifactTaskId:string;artifactRootTaskId:string;payloadDigest:string;computedPayloadDigest:string;artifactDigest:string;nativeArtifactDigest:string;receiptId:string;receiptDigest:string}
export interface ReceivedEffect {id:string;payloadDigest:string;computedPayloadDigest:string;artifactDigest:string;bytesDigest:string}
export interface EffectPost {id:string;payloadDigest:string;computedPayloadDigest:string;artifactDigest:string;status:number}
export function verifyModelCalls(physical:PhysicalModelCall[],native:NativeModelCall[]){
 const errors:string[]=[],counts=new Map<string,number>(),matched=new Set<string>();
 const byProvider=new Map<string,NativeModelCall[]>(),byAttempt=new Map<string,NativeModelCall[]>();
 const nativeIds=new Set<string>();
 for(const item of native){if(nativeIds.has(item.operationId))errors.push(`Duplicate native operation ${item.operationId}`);nativeIds.add(item.operationId);if(item.providerRequestId)byProvider.set(item.providerRequestId,[...(byProvider.get(item.providerRequestId)??[]),item]);const key=item.operationId+':'+item.attemptId;byAttempt.set(key,[...(byAttempt.get(key)??[]),item]);}
 for(const call of physical){
  const candidates=[...new Set([...(byProvider.get(call.id)??[]),...(call.operationId&&call.attemptId?byAttempt.get(call.operationId+':'+call.attemptId)??[]:[])])];
  if(candidates.length!==1){errors.push(`Physical call ${call.id} has ${candidates.length} native matches`);continue;}
  const item=candidates[0]!;const key=item.operationId+':'+item.attemptId;matched.add(key);counts.set(key,(counts.get(key)??0)+1);
  if(call.attributionCount!==undefined&&call.attributionCount!==1||call.operationId&&call.operationId!==item.operationId||call.attemptId&&call.attemptId!==item.attemptId||item.bodyDigest!==call.bodyDigest||call.taskId&&call.taskId!==item.taskId||call.rootTaskId&&call.rootTaskId!==item.rootTaskId)errors.push(`Physical call ${call.id} attribution differs`);
  if(item.state==='completed'&&(call.status!==200||!call.endedAt))errors.push(`Completed operation ${item.operationId} lacks an actual successful physical response`);
  if(item.errorCode==='MODEL_RATE_LIMITED'&&call.status!==429)errors.push(`Native rejection ${item.operationId} differs from its physical response`);
  if(call.status===429&&(item.state!=='failed'||item.errorCode!=='MODEL_RATE_LIMITED'))errors.push(`Physical rejection ${call.id} lacks its native rejected receipt`);
 }
 for(const item of native)if(!matched.has(item.operationId+':'+item.attemptId))errors.push(`Native operation ${item.operationId} lacks a physical request`);
 for(const[id,count]of counts)if(count!==1)errors.push(`Native operation ${id} made ${count} physical calls`);
 return{physical:physical.length,native:native.length,matched:matched.size,errors};
}
export function verifyEffects(actions:EffectIdentity[],received:ReceivedEffect[],posts:EffectPost[]){
 const errors:string[]=[];
 for(const action of actions){const deliveries=received.filter(row=>row.id===action.id),requests=posts.filter(row=>row.id===action.id);
  if(deliveries.length!==1||requests.length!==1){errors.push(`Effect ${action.id} lacks one exact receiver row/POST`);continue;}
  const delivery=deliveries[0]!,request=requests[0]!;
  if(action.taskId!==action.artifactTaskId||action.rootTaskId!==action.nativeRootTaskId||action.rootTaskId!==action.artifactRootTaskId||action.receiptId!==action.id)errors.push(`Effect ${action.id} task/root/artifact attribution differs`);
  if([action.computedPayloadDigest,action.receiptDigest,delivery.payloadDigest,delivery.computedPayloadDigest,request.payloadDigest,request.computedPayloadDigest].some(value=>value!==action.payloadDigest)||[action.nativeArtifactDigest,delivery.artifactDigest,delivery.bytesDigest,request.artifactDigest].some(value=>value!==action.artifactDigest)||request.status!==200)errors.push(`Effect ${action.id} digest or response differs`);
 }
 if(received.some(row=>!actions.some(action=>action.id===row.id))||posts.some(row=>!actions.some(action=>action.id===row.id)))errors.push('Receiver has an unattributed effect or POST');
 return{actions:actions.length,received:received.length,posts:posts.length,errors};
}
export function classifyRootOutcomes(roots:{id:string;state:string;errorCode:string|null}[],fault:string,affected:string[]){
 const errors:string[]=[],expected:{id:string;state:string;errorCode:string|null}[]=[];
 for(const root of roots){if(root.state==='completed')continue;
  const allowed=affected.includes(root.id)&&(fault==='worker-loss'&&root.state==='uncertain'||fault==='provider-throttle'&&['failed','incomplete'].includes(root.state)&&['MODEL_RATE_LIMITED','CHILD_PARTIAL_FAILURE'].includes(root.errorCode??''));
  if(allowed)expected.push(root);else errors.push(`Unexpected ${root.state} root ${root.id}: ${root.errorCode??'none'}`);
 }
 return{expected,errors};
}
export function fatalLoadFindings(unmet:string[]){return unmet.filter(item=>!/^(approved-source FAQ grounding subset|delayed approval and hot-conversation ownership mix|30s sustained\/10s burst timing|worker loss,lease expiry,provider throttling,collector outage,reconnect fault stages|full root-to-physical-effect and per-tenant fairness audit|active concurrency target requires measured peak, accepted backlog is insufficient)$/.test(item));}

/** Children execute directly through durable workflow calls; terminal outbox cleanup is not their dispatch time. */
export function verifyQueueAges(metrics:{dispatch_lag_p95_ms:number|string|null;child_count:number;child_started_count:number;child_activation_p95_ms:number|string|null},limitMs:number){
 const errors:string[]=[];
 if(metrics.dispatch_lag_p95_ms===null||!Number.isFinite(Number(metrics.dispatch_lag_p95_ms))||Number(metrics.dispatch_lag_p95_ms)>limitMs)errors.push('Queue age threshold failed');
 if(!Number.isSafeInteger(metrics.child_count)||metrics.child_count<0||metrics.child_started_count!==metrics.child_count)errors.push('Child first-native-operation coverage missing');
 if(metrics.child_count&&(metrics.child_activation_p95_ms===null||!Number.isFinite(Number(metrics.child_activation_p95_ms))||Number(metrics.child_activation_p95_ms)>limitMs))errors.push('Child admission-to-first-native-operation threshold failed');
 return errors;
}
