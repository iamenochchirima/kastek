import type { Pool,PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { legacyControlPrefix } from "./legacy-control-prefix";

/** Values are supplied by trusted task metadata, never guessed from their format. */
export function projectRecipientText(text:string, scope:{controlValues:readonly string[];userText:readonly string[];permittedValues?:readonly string[]}):string {
  const permitted=new Set(scope.permittedValues??[]);
  const values=[...new Set(scope.controlValues.filter(value=>value.length>=12 && !permitted.has(value) && !scope.userText.some(input=>input.includes(value))))]
    .sort((a,b)=>b.length-a.length);
  for(const value of values)text=text.split(value).join("[internal reference]");
  return text;
}

/** A user may request a public platform identifier; that never permits internal control IDs. */
export function explicitlyRequestsPlatformIdentifier(text:string):boolean {
  const value=text.normalize("NFKC");
  if(/\b(?:don't|dont|do not|without|omit|exclude|hide|never|no)\b[\s\S]{0,80}\b(?:page|facebook|instagram|social|platform|account)?\s*(?:ids?|identifiers?)\b/i.test(value))return false;
  return /\b(?:page|facebook|instagram|social|platform|account)\b/i.test(value)&&
    /\b(?:ids?|identifiers?)\b/i.test(value)&&
    /\b(?:what|which|show|give|tell|provide|include|list|display|share)\b/i.test(value);
}

/** Call only after the host has authorized access to this task and its conversation. */
export async function taskRecipientTextScope(pool:Pool|PoolClient,taskId:string,texts:readonly string[]):Promise<{
  controlValues:string[];userText:string[];permittedValues:string[];
}> {
  if(!texts.length)return {controlValues:[],userText:[],permittedValues:[]};
  const rows=(await pool.query(`WITH selected AS (
    SELECT root_task_id,organization_id,conversation_id,principal,turn_sequence,input FROM agents_platform.tasks WHERE id=$1
  ), scoped AS (
    SELECT t.id,t.version_id,t.grant_id,t.product FROM agents_platform.tasks t JOIN selected s ON t.organization_id=s.organization_id AND t.principal=s.principal
      AND (t.root_task_id=s.root_task_id OR (t.conversation_id=s.conversation_id AND t.turn_sequence<=s.turn_sequence))
  ), controls AS (
    SELECT id::text AS value FROM scoped
    UNION SELECT version_id::text FROM scoped
    UNION SELECT grant_id::text FROM scoped
    UNION SELECT ref.id FROM agents_platform.product_references ref JOIN scoped t ON t.id=ref.source_task_id
    UNION SELECT ref.resource_id FROM agents_platform.product_references ref JOIN scoped t ON t.id=ref.source_task_id
    UNION SELECT o.id::text FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
    UNION SELECT item->>'id' FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.output#>'{value,result,connections}')='array'
        THEN o.output#>'{value,result,connections}' ELSE '[]'::jsonb END) item
      WHERE t.product='growth' AND o.request->>'productOperation'='connections.list'
    UNION SELECT item->>'id' FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.output#>'{value,result,accounts}')='array'
        THEN o.output#>'{value,result,accounts}' ELSE '[]'::jsonb END) item
      WHERE t.product='growth' AND o.request->>'productOperation'='content.accounts.list'
  ), platform_ids AS (
    SELECT item->>'externalAccountId' AS value FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.output#>'{value,result,connections}')='array'
        THEN o.output#>'{value,result,connections}' ELSE '[]'::jsonb END) item
      WHERE t.product='growth' AND o.request->>'productOperation'='connections.list'
    UNION SELECT coalesce(item->>'platformAccountId',item->>'externalAccountId',item->>'external_account_id') FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.output#>'{value,result,accounts}')='array'
        THEN o.output#>'{value,result,accounts}' ELSE '[]'::jsonb END) item
      WHERE t.product='growth' AND o.request->>'productOperation'='content.accounts.list'
  )
  , legacy AS (
    SELECT o.output#>>'{value,result,chunk}' AS chunk,o.request->>'productOperation' AS operation
    FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
    WHERE t.product='growth' AND o.request->>'productOperation' IN ('connections.list','content.accounts.list')
      AND o.output#>>'{value,result,encoding}'='json' AND o.output#>>'{value,result,offset}'='0'
      AND octet_length(o.output#>>'{value,result,chunk}')<=8192 ORDER BY o.started_at DESC,o.id DESC
  )
  SELECT DISTINCT 'control' AS kind,c.value,NULL::text AS operation FROM controls c WHERE length(c.value)>=12
    AND EXISTS(SELECT 1 FROM unnest($2::text[]) AS candidate(text) WHERE strpos(candidate.text,c.value)>0)
    AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks t JOIN selected s ON t.conversation_id=s.conversation_id
      WHERE t.parent_task_id IS NULL AND t.organization_id=s.organization_id AND t.principal=s.principal
        AND t.turn_sequence<=s.turn_sequence AND strpos(t.input,c.value)>0)
  UNION ALL SELECT DISTINCT 'platform',p.value,NULL::text FROM platform_ids p CROSS JOIN selected s
    WHERE length(p.value)>=12 AND EXISTS(SELECT 1 FROM unnest($2::text[]) AS candidate(text) WHERE strpos(candidate.text,p.value)>0)
  UNION ALL SELECT 'request',s.input,NULL::text FROM selected s
  UNION ALL SELECT 'legacy',chunk,operation FROM legacy
  UNION ALL SELECT 'credential',o.output#>>'{value,result,previewUrl}',NULL::text
    FROM agents_platform.operations o JOIN scoped t ON t.id=o.task_id
    WHERE t.product='growth' AND o.request->>'productOperation'='content.media.preview'
      AND length(o.output#>>'{value,result,previewUrl}')>=12
      AND EXISTS(SELECT 1 FROM unnest($2::text[]) AS candidate(text)
        WHERE strpos(candidate.text,o.output#>>'{value,result,previewUrl}')>0)`,[taskId,texts])).rows;
  const controlValues=rows.filter(row=>row.kind!=="legacy"&&row.kind!=="request"&&typeof row.value==="string").map(row=>row.value as string);
  const requestText=rows.find(row=>row.kind==="request"&&typeof row.value==="string")?.value as string|undefined;
  const permittedValues=explicitlyRequestsPlatformIdentifier(requestText??"")
    ?rows.filter(row=>row.kind==="platform"&&typeof row.value==="string").map(row=>row.value as string):[];
  const legacy=[...new Set(rows.filter(row=>row.kind==="legacy"&&typeof row.value==="string")
    .flatMap(row=>legacyControlPrefix(row.value,row.operation)).filter(value=>value.length>=12&&texts.some(text=>text.includes(value))))];
  if(legacy.length){
    const safe=(await pool.query(`SELECT value FROM unnest($2::text[]) value WHERE NOT EXISTS (
      SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.tasks selected ON selected.id=$1
      WHERE t.conversation_id=selected.conversation_id AND t.organization_id=selected.organization_id
        AND t.parent_task_id IS NULL AND t.principal=selected.principal AND t.turn_sequence<=selected.turn_sequence
        AND strpos(t.input,value)>0)`,[taskId,legacy])).rows;
    controlValues.push(...safe.map(row=>row.value));
  }
  return {controlValues,userText:[],permittedValues};
}

export async function projectWorkProgress<T extends {record:{objective:string;steps:{title:string}[];questions:string[]}|null}>(
  pool:Pool|PoolClient,taskId:string,progress:T,
):Promise<T> {
  if(!progress.record)return progress;
  const record=progress.record,texts=[record.objective,...record.steps.map(step=>step.title),...record.questions];
  const scope=await taskRecipientTextScope(pool,taskId,texts);
  return {...progress,record:{...record,objective:projectRecipientText(record.objective,scope),
    steps:record.steps.map(step=>({...step,title:projectRecipientText(step.title,scope)})),
    questions:record.questions.map(question=>projectRecipientText(question,scope))}};
}

/** Project a page after its host has independently authorized every included message. */
export async function projectRecipientMessages<T extends {role:string;text:string}>(pool:Pool|PoolClient,taskId:string,messages:T[]):Promise<T[]> {
  const outputs=messages.filter(message=>message.role==="assistant").map(message=>message.text);
  if(!outputs.length)return messages;
  const scope=await taskRecipientTextScope(pool,taskId,outputs);
  return messages.map(message=>message.role==="assistant"?{...message,text:projectRecipientText(message.text,scope)}:message);
}

/** Keep exact file bytes and digests intact. Reject a known control reference before delivery. */
export async function assertRecipientArtifact(pool:Pool|PoolClient,taskId:string,contentType:string,content:Uint8Array):Promise<void> {
  if(!/^(text\/|application\/json(?:;|$))/i.test(contentType))return;
  let text:string;
  try{text=new TextDecoder("utf-8",{fatal:true}).decode(content);}
  catch{throw new PlatformError("ARTIFACT_DISCLOSURE_UNAVAILABLE",403,"This file cannot be checked for internal references");}
  if(projectRecipientText(text,await taskRecipientTextScope(pool,taskId,[text]))!==text)
    throw new PlatformError("ARTIFACT_DISCLOSURE_BLOCKED",403,"This file contains an internal reference and cannot be displayed");
}
