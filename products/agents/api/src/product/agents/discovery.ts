import type { Pool } from "pg";
import { PlatformError,type TaskState } from "../../contracts/contracts";
import type { Account } from "../../contracts/records";
import { finishPage,readPageCursor,type PageQuery } from "../../infrastructure/read-pages";
import { PlatformStore } from "./store";

export interface AgentSummary {id:string;name:string;avatar:string;draftRevision:number;updatedAt:Date;offering:"faq"|"customer-service"|null;responsibilities:string[];activeChannels:string[];lastCustomerConversationAt:Date|null;latestVersion:{id:string;number:number;draftRevision:number;executionKind:string}|null;hasUnpublishedChanges:boolean}
export interface ConversationSummary {id:string;agentId:string;agentName:string;versionId:string;versionNumber:number;title:string;updatedAt:Date;state:TaskState;canContinue:true}
export interface TaskSummary {id:string;agentId:string;agentName:string;versionId:string;versionNumber:number;conversationId:string|null;state:TaskState;createdAt:Date;updatedAt:Date;canControl:boolean;reviewOnly:boolean}
const missing=()=>{throw new PlatformError("NOT_FOUND",404,"Record not found");};
export class PlatformDiscovery {
  constructor(private pool:Pool,private store:PlatformStore){}
  async agents(user:Account,org:string,query:PageQuery&{q?:string;status?:"all"|"configured"|"changes-pending"|"setup"}) {
    await this.store.requireMembership(user.id,org);
    const q=query.q?.trim()??"";
    const status=query.status??"all";
    const scope={kind:"agents",user:user.id,org,q,status},cursor=readPageCursor(query.cursor,scope);
    const rows=(await this.pool.query(`WITH page AS MATERIALIZED (
      SELECT a.id,a.organization_id,a.name,a.avatar,a.offering,a.setup,a.draft_revision,a.updated_at,a.created_at,
        v.id AS version_id,v.number AS version_number,v.draft_revision AS version_draft_revision,v.execution_kind AS version_execution_kind
      FROM agents_platform.agents a
      LEFT JOIN LATERAL (SELECT id,number,draft_revision,execution_kind FROM agents_platform.agent_versions WHERE agent_id=a.id ORDER BY number DESC LIMIT 1) v ON true
      WHERE a.organization_id=$1 AND a.deleted_at IS NULL AND strpos(lower(a.name),lower($6))>0 AND a.created_at<=$2
        AND ($3::timestamptz IS NULL OR (a.created_at,a.id)<($3::timestamptz,$4::uuid))
        AND ($7='all' OR ($7='setup' AND v.id IS NULL) OR ($7='configured' AND v.id IS NOT NULL AND v.draft_revision=a.draft_revision)
          OR ($7='changes-pending' AND v.id IS NOT NULL AND v.draft_revision<>a.draft_revision))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $5
    ) SELECT a.id,a.name,a.avatar,a.offering,a.draft_revision AS "draftRevision",a.updated_at AS "updatedAt",a.created_at::text AS position,
      COALESCE(a.setup->'responsibilities','[]'::jsonb) AS responsibilities,
      CASE WHEN a.version_id IS NULL THEN NULL ELSE json_build_object('id',a.version_id,'number',a.version_number,'draftRevision',a.version_draft_revision,'executionKind',a.version_execution_kind) END AS "latestVersion",
      (a.version_id IS NULL OR a.version_draft_revision<>a.draft_revision) AS "hasUnpublishedChanges",
      ARRAY(SELECT DISTINCT channels.kind FROM (
        SELECT 'website'::text AS kind FROM agents_platform.website_deployments w
        WHERE w.organization_id=a.organization_id AND w.agent_id=a.id AND w.revoked_at IS NULL
        UNION ALL
        SELECT c.kind FROM agents_platform.channel_deployments d
        JOIN agents_platform.channel_connections c ON c.organization_id=d.organization_id AND c.id=d.connection_id
        WHERE d.organization_id=a.organization_id AND d.agent_id=a.id AND d.state='active' AND c.state='active'
          AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=d.id)
      ) channels ORDER BY channels.kind) AS "activeChannels",
      (SELECT c.updated_at FROM agents_platform.customer_conversations c
        WHERE c.organization_id=a.organization_id AND c.agent_id=a.id
          AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id=c.session_id)
          AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=c.channel_deployment_id)
        ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) AS "lastCustomerConversationAt"
      FROM page a
      ORDER BY a.created_at DESC,a.id DESC`,[org,cursor.snapshot,cursor.position||null,cursor.id||null,query.limit+1,q,status])).rows as (AgentSummary&{position:string})[];
    return finishPage(rows,query.limit,scope,cursor.snapshot,row=>({position:row.position,id:row.id}));
  }
  async conversations(user:Account,org:string,query:PageQuery&{agentId:string;versionId?:string;state?: "active" | "archived"}) {
    await this.store.getAgent(user.id,org,query.agentId);
    if(query.versionId&&!(await this.pool.query("SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 AND id=$3",[org,query.agentId,query.versionId])).rowCount)missing();
    const archived=(query.state??"active")==="archived";
    const scope={kind:"conversations",user:user.id,org,agentId:query.agentId,versionId:query.versionId??null,state:archived?"archived":"active"},cursor=readPageCursor(query.cursor,scope);
    const principal={kind:"human",issuer:user.issuer,subject:user.subject};
    const rows=(await this.pool.query(`SELECT c.id,c.agent_id AS "agentId",a.name AS "agentName",last.version_id AS "versionId",v.number AS "versionNumber",
      COALESCE(NULLIF(btrim(c.title),''),left(regexp_replace(first.input,'[[:cntrl:]]',' ','g'),100)) AS title,last.created_at AS "updatedAt",last.state,true AS "canContinue",last.created_at::text AS position
      FROM agents_platform.conversations c JOIN agents_platform.agents a ON a.id=c.agent_id
      JOIN LATERAL (SELECT t.version_id,t.created_at,t.state FROM agents_platform.tasks t WHERE t.conversation_id=c.id AND t.parent_task_id IS NULL AND t.product='agents' AND t.caller_client_id='agents-execution' AND t.resource_id=$2::text AND t.principal=$3::jsonb AND t.created_at<=$4 ORDER BY t.turn_sequence DESC LIMIT 1) last ON true
      JOIN LATERAL (SELECT t.input FROM agents_platform.tasks t WHERE t.conversation_id=c.id AND t.parent_task_id IS NULL AND t.principal=$3::jsonb ORDER BY t.turn_sequence LIMIT 1) first ON true
      JOIN agents_platform.agent_versions v ON v.id=last.version_id
      WHERE c.organization_id=$1 AND c.agent_id=$2::uuid AND c.principal=$3::jsonb AND c.deployment_id IS NULL AND (c.deleted_at IS NOT NULL)=$9::boolean
      AND ($5::uuid IS NULL OR last.version_id=$5) AND ($6::timestamptz IS NULL OR (last.created_at,c.id)<($6::timestamptz,$7::uuid))
      ORDER BY last.created_at DESC,c.id DESC LIMIT $8`,[org,query.agentId,JSON.stringify(principal),cursor.snapshot,query.versionId??null,cursor.position||null,cursor.id||null,query.limit+1,archived])).rows as (ConversationSummary&{position:string})[];
    for(const row of rows)row.title=row.title.trim()||"Conversation";
    return finishPage(rows,query.limit,scope,cursor.snapshot,row=>({position:row.position,id:row.id}));
  }
  async tasks(user:Account,org:string,query:PageQuery&{agentId?:string;state?:TaskState}) {
    await this.store.requireMembership(user.id,org);
    if(query.agentId)await this.store.getAgent(user.id,org,query.agentId);
    const scope={kind:"tasks",user:user.id,org,agentId:query.agentId??null,state:query.state??null},cursor=readPageCursor(query.cursor,scope);
    const rows=(await this.pool.query(`WITH visible AS (
      SELECT t.*,v.agent_id,a.name AS agent_name,v.number AS version_number,
      (t.principal->>'kind'='automation' AND au.owner_account_id<>$2::uuid) AS review_only
      FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.agents a ON a.id=v.agent_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      LEFT JOIN agents_platform.automations au ON t.principal->>'kind'='automation' AND au.id::text=t.principal->>'id' AND au.organization_id=t.organization_id AND au.owner_account_id::text=t.principal->>'ownerAccountId'
      LEFT JOIN agents_platform.memberships owner ON owner.account_id=au.owner_account_id AND owner.organization_id=au.organization_id AND owner.revoked_at IS NULL
      LEFT JOIN agents_platform.automation_occurrences oc ON oc.task_id=t.id AND oc.automation_id=au.id
      LEFT JOIN agents_platform.automation_revisions ar ON ar.automation_id=au.id AND ar.revision=oc.revision
      WHERE t.organization_id=$1 AND t.product='agents' AND t.parent_task_id IS NULL
      AND ((t.caller_client_id='agents-execution' AND t.principal=$3::jsonb AND t.resource_id=v.agent_id::text)
        OR (t.caller_client_id='agents-automation' AND t.resource_id=au.id::text AND owner.account_id IS NOT NULL AND (au.owner_account_id=$2::uuid OR ar.configuration->>'reviewerAccountId'=$2::text)))
      AND ($4::uuid IS NULL OR v.agent_id=$4) AND ($5::text IS NULL OR t.state=$5)
      AND t.created_at<=$6 AND ($7::timestamptz IS NULL OR (t.created_at,t.id)<($7::timestamptz,$8::uuid))
    ) SELECT id,agent_id AS "agentId",agent_name AS "agentName",version_id AS "versionId",version_number AS "versionNumber",
      CASE WHEN review_only THEN NULL ELSE conversation_id END AS "conversationId",state,created_at AS "createdAt",updated_at AS "updatedAt",
      NOT coalesce(review_only,false) AS "canControl",coalesce(review_only,false) AS "reviewOnly",created_at::text AS position
      FROM visible ORDER BY created_at DESC,id DESC LIMIT $9`,[org,user.id,JSON.stringify({kind:"human",issuer:user.issuer,subject:user.subject}),query.agentId??null,query.state??null,cursor.snapshot,cursor.position||null,cursor.id||null,query.limit+1])).rows as (TaskSummary&{position:string})[];
    return finishPage(rows,query.limit,scope,cursor.snapshot,row=>({position:row.position,id:row.id}));
  }
}
