import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { HubSpotContactsClient } from '../../adapters/providers/hubspot-contacts';
import { customerContactIntakeSchema } from '../../capabilities/connected-tools/customer-native-policy';
import { PlatformError,requestDigest } from '../../contracts/contracts';
import type { ActionScope } from '../../contracts/connections';
import { transaction } from '../../infrastructure/database';
import type { ProviderServices } from '../connections/provider-services';
import { connectedUncertainClaimDigest,connectedUncertainSource } from './connected-uncertain-recovery';

const denied=()=>new PlatformError('RECONCILIATION_DENIED',403,'Contact check unavailable');
type State='found'|'inconclusive'|'unavailable';

/** A separate staff read; it never changes or replays the original customer write. */
export class ConnectedReconciliation {
  constructor(private readonly pool:Pool,private readonly providers:ProviderServices,private readonly testBaseUrl?:string) {}
  private async authority(db:PoolClient,scope:ActionScope,conversationId:string,operationId:string) {
    const member=await db.query(`SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL FOR SHARE`,[scope.organizationId,scope.accountId]);
    if(!member.rowCount)throw denied();
    const intent=(await db.query(`SELECT * FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1 AND organization_id=$2 AND conversation_id=$3 FOR SHARE`,[operationId,scope.organizationId,conversationId])).rows[0];
    const source=await connectedUncertainSource(db,operationId);
    if(!intent||!source||source.state!=='uncertain'||source.organization_id!==scope.organizationId||source.conversation_id!==conversationId||connectedUncertainClaimDigest(source)!==intent.claim_digest || source.binding.definition.providerOperation!=='contacts.create')throw denied();
    const connection=(await db.query(`SELECT c.account_id,c.policy_revision,p.sharing,p.provider_id FROM agents_platform.connections c JOIN agents_platform.native_provider_connections p ON p.connection_id=c.id AND p.organization_id=c.organization_id
      WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3 AND c.state='active' AND p.status='ready' AND p.sharing='organization_service' FOR SHARE OF c,p`,[source.connection_id,scope.organizationId,scope.accountId])).rows[0];
    if(!connection || connection.provider_id!=='hubspot'||connection.policy_revision!==source.connection_policy_revision)throw denied();
    const args=customerContactIntakeSchema.parse(source.arguments);
    return {source,intent,args,connectionId:source.connection_id as string,policyRevision:Number(source.connection_policy_revision)};
  }
  async reconcile(scope:ActionScope,conversationId:string,operationId:string,requestId:string):Promise<{state:State}> {
    z.uuid().parse(conversationId);z.uuid().parse(requestId);
    if(!operationId||operationId.length>256)throw denied();
    const initial=await transaction(this.pool,async db=>{await db.query('SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE',[scope.organizationId]);return this.authority(db,scope,conversationId,operationId);});
    await this.providers.ensureFresh(scope,initial.connectionId);
    const requestKey=requestDigest({operationId,conversationId,accountId:scope.accountId});
    const prepared=await transaction(this.pool,async db=>{
      await db.query('SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE',[scope.organizationId]);
      const current=await this.authority(db,scope,conversationId,operationId);
      const prior=(await db.query(`SELECT * FROM agents_platform.connected_reconciliation_attempts WHERE organization_id=$1 AND requested_by=$2 AND request_key=$3 FOR UPDATE`,[scope.organizationId,scope.accountId,requestId])).rows[0];
      if(prior){if(prior.request_digest!==requestKey)throw new PlatformError('IDEMPOTENCY_CONFLICT',409,'Request changed');
        if(['found','inconclusive','unavailable'].includes(prior.state))return {state:prior.state as State};
        if(new Date(prior.deadline_at).getTime()<=Date.now()) {await db.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='unavailable',lease_token=NULL,lease_until=NULL,observed_at=clock_timestamp(),reason='deadline_expired' WHERE id=$1",[prior.id]);return {state:'unavailable' as State};}
        throw new PlatformError('RECONCILIATION_IN_PROGRESS',409,'Contact check in progress');}
      await db.query(`UPDATE agents_platform.connected_reconciliation_attempts SET state='unavailable',lease_token=NULL,lease_until=NULL,observed_at=clock_timestamp(),reason='deadline_expired' WHERE operation_id=$1 AND state IN ('queued','claimed') AND deadline_at<=clock_timestamp()`,[operationId]);
      if((await db.query(`SELECT 1 FROM agents_platform.connected_reconciliation_attempts WHERE operation_id=$1 AND state IN ('queued','claimed')`,[operationId])).rowCount)throw new PlatformError('RECONCILIATION_IN_PROGRESS',409,'Contact check in progress');
      if((await db.query(`SELECT 1 FROM agents_platform.connected_reconciliation_attempts WHERE operation_id=$1 AND created_at>now()-interval '30 seconds'`,[operationId])).rowCount)throw new PlatformError('RECONCILIATION_RATE_LIMIT',429,'Try again later');
      const credentials=await this.providers.store('hubspot').resolveCredential(db,scope,current.connectionId,current.policyRevision);
      const id=randomUUID(),lease=randomUUID();
      const attempt=(await db.query(`INSERT INTO agents_platform.connected_reconciliation_attempts(id,organization_id,conversation_id,operation_id,requested_by,request_key,request_digest,source_claim_digest,connection_policy_revision,state,deadline_at,lease_token,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'claimed',statement_timestamp()+interval '29 seconds',$10,statement_timestamp()+interval '29 seconds') RETURNING deadline_at`,[id,scope.organizationId,conversationId,operationId,scope.accountId,requestId,requestKey,current.intent.claim_digest,current.policyRevision,lease])).rows[0];
      return {id,lease,deadline:new Date(attempt.deadline_at).getTime(),credentials,args:current.args,connectionId:current.connectionId,policyRevision:current.policyRevision};
    });
    if('state' in prepared)return {state:prepared.state!};
    const check=async()=>transaction(this.pool,async db=>{const current=await this.authority(db,scope,conversationId,operationId);const cred=await this.providers.store('hubspot').resolveCredential(db,scope,current.connectionId,current.policyRevision);if(cred.connection.revision!==prepared.credentials.connection.revision)throw denied();
      if(!(await db.query("SELECT 1 FROM agents_platform.connected_reconciliation_attempts WHERE id=$1 AND state='claimed' AND lease_token=$2 AND lease_until>clock_timestamp() FOR SHARE",[prepared.id,prepared.lease])).rowCount)throw denied();});
    let outcome:State='unavailable',reason='provider_unavailable',digest:string|null=null;
    try {
      const client=new HubSpotContactsClient(prepared.credentials.authorization,{deadlineAt:prepared.deadline,testBaseUrl:this.testBaseUrl,beforeAttempt:async()=>check()});
      const result=await client.reconcileContact({organizationId:scope.organizationId,requestId:operationId,...prepared.args,requestDigest:requestKey});
      if(result.state==='confirmed'){outcome='found';reason='matching_record_observed';digest=result.receiptDigest;}
      else if(result.reason==='CONTACT_NOT_OBSERVED'){outcome='inconclusive';reason='not_observed';digest=result.receiptDigest??null;}
      else if(result.reason==='CONTACT_INTENT_MISMATCH'){outcome='inconclusive';reason='mismatch';digest=result.receiptDigest??null;}
    }catch{outcome='unavailable';reason='provider_unavailable';}
    return transaction(this.pool,async db=>{
      try {await this.authority(db,scope,conversationId,operationId);const current=await this.providers.store('hubspot').resolveCredential(db,scope,prepared.connectionId,prepared.policyRevision);if(current.connection.revision!==prepared.credentials.connection.revision)throw denied();}
      catch {outcome='unavailable';reason='authority_changed';digest=null;}
      const updated=await db.query(`UPDATE agents_platform.connected_reconciliation_attempts SET state=$3,lease_token=NULL,lease_until=NULL,observed_at=clock_timestamp(),provider_response_digest=$4,reason=$5 WHERE id=$1 AND lease_token=$2 AND state='claimed' AND lease_until>clock_timestamp() RETURNING state`,[prepared.id,prepared.lease,outcome,digest,reason]);
      if(!updated.rowCount)throw new PlatformError('RECONCILIATION_UNAVAILABLE',409,'Contact check unavailable');
      return {state:outcome};
    });
  }
}
