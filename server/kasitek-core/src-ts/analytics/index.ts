import type { PoolClient } from 'pg';
import type { AnalyticsOutboxRecord,EventInput,ObservationInput,ScopeDefinitionInput,ManifestInput } from '@kasitek/contracts';
import { coreProducerConfig,buildEvent,buildObservation,buildScopeDefinition,buildManifest,enqueueOutbox } from '@kasitek/server-support/analytics-producer';
export { coreProducerConfig as producerConfig };
export async function enqueueRecord(transaction:PoolClient,record:AnalyticsOutboxRecord){return enqueueOutbox(transaction,record);}
export async function enqueueEvent(transaction:PoolClient,input:EventInput){return enqueueRecord(transaction,buildEvent(coreProducerConfig(),input));}
export async function enqueueObservation(transaction:PoolClient,input:ObservationInput){return enqueueRecord(transaction,buildObservation(coreProducerConfig(),input));}
export async function enqueueScopeDefinition(transaction:PoolClient,input:ScopeDefinitionInput){return enqueueRecord(transaction,buildScopeDefinition(coreProducerConfig(),input));}
export async function enqueueManifest(transaction:PoolClient,input:ManifestInput){return enqueueRecord(transaction,buildManifest(coreProducerConfig(),input));}
export async function enqueueOrganizationScopeDefinition(transaction:PoolClient,organizationId:string,sourceVersion:number|bigint,reportingTimezone:string,status:string){const recordId=`core-scope:organization:${organizationId}:${sourceVersion}`;return enqueueScopeDefinition(transaction,{record_id:recordId,source_domain:'scopes',source_stream_key:`organization:${organizationId}:scopes`,contract_name:'core.scope.definition@1',schema_version:1,scope_kind:'core_organization',scope_external_id:organizationId,parent_scope_external_id:null,reporting_timezone:reportingTimezone,status,source_version:sourceVersion,idempotency_key:recordId});}
