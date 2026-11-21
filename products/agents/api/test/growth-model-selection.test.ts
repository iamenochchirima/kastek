import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {setupPlatformSchema} from '../src/composition/setup';
import {PlatformStore} from '../src/product/agents/store';
import {defaultBusinessConfiguration,requestDigest} from '../src/contracts/contracts';
import {transaction} from '../src/infrastructure/database';
import {connectFixtureModel} from './model-fixture';
import {dropClosedTestDatabase} from './support/database-cleanup';
import {ProductAgentExecutionService} from '../src/product/integrations/product-agent-execution';
import type {GrowthProductRuntime} from '../src/execution/products/growth-runtime';
import {listGrowthModels,authorizeGrowthModelSelection} from '../src/product/integrations/growth-model-selection';
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)('Growth authorized model selection',()=>{
 const database='agents_picker_'+randomUUID().replaceAll('-','');let admin:Pool,pool:Pool;
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname='/'+database;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 it('lists only scoped saved authorized models and selects without provider calls',async()=>{
  const store=new PlatformStore(pool),account=await store.ensureAccount({issuer:'http://localhost/picker',subject:randomUUID(),email:'fixture@example.test',displayName:'Fixture'});
  const org=await store.createOrganization(account.id,'Picker'),configured=await connectFixtureModel(pool,account.id,org.id);
  const configuration=defaultBusinessConfiguration();configuration.tools=['knowledge.search'];const agent=await store.createAgent({accountId:account.id,organizationId:org.id,name:'Picker',configuration});
  const version=await store.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const feature={organization_id:org.id,agent_id:agent.id,version_id:version.id,revision:1,configuration};
  const snapshot=(await pool.query('SELECT snapshot FROM agents_platform.model_provider_catalogues WHERE connection_id=$1',[configured.connection.id])).rows[0].snapshot;
  const alternative=structuredClone(snapshot.models[0]);alternative.id='fixture/alternative';alternative.name='Alternative';alternative.capabilities.tools={value:null,evidence:'unknown',source:null};snapshot.models.push(alternative);snapshot.models.push({...snapshot.models[0],id:'fixture/not-authorized',name:'Unapproved'});
  await pool.query('UPDATE agents_platform.model_provider_catalogues SET snapshot=$2,snapshot_digest=$3 WHERE connection_id=$1',[configured.connection.id,snapshot,requestDigest(snapshot)]);
  const grant=randomUUID();await pool.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids) VALUES($1,$2,$3,$4,$5,$6)`,[grant,org.id,configured.connection.id,{kind:'service',serviceId:'product-default',product:'growth'},JSON.stringify(['primary','compaction','delegated']),JSON.stringify([configured.modelId,'fixture/alternative'])]);
  await pool.query("INSERT INTO agents_platform.product_model_defaults(product,organization_id,connection_id,model_id,use_grant_id) VALUES('growth',$1,$2,$3,$4)",[org.id,configured.connection.id,configured.modelId,grant]);
  await pool.query('UPDATE agents_platform.model_provider_use_grants SET consumer=$2 WHERE id=$1',[grant,{kind:'service',serviceId:'foreign-service',product:'growth'}]);
  expect((await transaction(pool,db=>listGrowthModels(db,feature))).models).toEqual([]);
  await pool.query('UPDATE agents_platform.model_provider_use_grants SET consumer=$2 WHERE id=$1',[grant,{kind:'service',serviceId:'product-default',product:'growth'}]);
  expect((await transaction(pool,db=>listGrowthModels(db,feature))).models.map(m=>m.modelId)).toEqual([configured.modelId]);
  await pool.query(`INSERT INTO agents_platform.model_provider_verifications(organization_id,connection_id,connection_revision,credential_revision,endpoint,protocol,model_id,model_revision,verification)
    SELECT organization_id,id,revision,credential_revision,endpoint,protocol,$2,$3,'tools_verified' FROM agents_platform.model_provider_connections WHERE id=$1`,[configured.connection.id,alternative.id,alternative.revision]);
  const inventory=await transaction(pool,db=>listGrowthModels(db,feature));expect(inventory.inherited).toBe(true);expect(inventory.models.map(m=>m.modelId).sort()).toEqual([configured.modelId,'fixture/alternative'].sort());
  expect(inventory.models.find(model=>model.modelId===configured.modelId)).toMatchObject({contextWindowTokens:snapshot.models[0].contextTokens.value,
    maxOutputTokens:snapshot.models[0].maxOutputTokens.value,pricing:{currency:'USD',inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}});
  const selected=await transaction(pool,db=>authorizeGrowthModelSelection(db,feature,{kind:'connection',connectionId:configured.connection.id,modelId:'fixture/alternative'}));
  expect((await transaction(pool,db=>listGrowthModels(db,{...feature,configuration:selected}))).defaultModel?.modelId).toBe(configured.modelId);
  expect(selected.model.selection).toEqual({kind:'connection',connectionId:configured.connection.id,modelId:'fixture/alternative'});
  await expect(transaction(pool,db=>authorizeGrowthModelSelection(db,feature,{kind:'connection',connectionId:configured.connection.id,modelId:'fixture/not-authorized'}))).rejects.toMatchObject({code:'MODEL_USE_DENIED'});
  expect((await transaction(pool,db=>authorizeGrowthModelSelection(db,{...feature,configuration:selected},{kind:'organization_default'}))).model.selection).toEqual({kind:'organization_default'});
  const tenantId=randomUUID(),issuer='http://localhost/picker-product';
  await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,'growth-api',$3)",[tenantId,org.id,issuer]);
  await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id) VALUES('growth',$1,'assistant',$2,$3,$4)",[tenantId,org.id,agent.id,version.id]);
  const runtime={client:{call:async()=>({authorized:true})}} as unknown as GrowthProductRuntime;
  const service=new ProductAgentExecutionService(pool,{issuer,actorIssuer:account.issuer,keys:{}},runtime);
  const command={version:'1' as const,requestId:randomUUID(),product:'growth' as const,tenantId,actor:{issuer:account.issuer,subject:account.subject},operation:'models.select' as const,
    input:{target:{kind:'product_feature' as const,featureId:'assistant'},expectedRevision:1,selection:{kind:'connection' as const,connectionId:configured.connection.id,modelId:'fixture/alternative'}}};
  expect(await service.execute(command)).toEqual({revision:2});expect(await service.execute(command)).toEqual({revision:2});
  expect((await pool.query('SELECT count(*)::int n FROM agents_platform.agent_versions WHERE agent_id=$1',[agent.id])).rows[0].n).toBe(2);
  await expect(service.execute({...command,requestId:randomUUID()})).rejects.toMatchObject({code:'CONFIGURATION_CHANGED'});
  await pool.query("UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL WHERE connection_id=$1",[configured.connection.id]);
  expect((await transaction(pool,db=>listGrowthModels(db,feature))).models).toEqual([]);
 });
});
