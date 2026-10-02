import test from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../src-ts/config.js';
const base={ANALYTICS_DATABASE_URL:'postgres://unused/analytics'};
test('Analytics config retains dedicated DB, raw numeric parsing and optional primary precedence',()=>{
 assert.throws(()=>readConfig({DATABASE_URL:'postgres://wrong'}),/ANALYTICS_DATABASE_URL/);
 assert.equal(readConfig({...base,PORT:'8123'}).api_port,8123);
 assert.equal(readConfig({...base,ANALYTICS_API_PORT:'',PORT:'8123'}).api_port,4300);
 for(const value of ['0','65536',' 4300 ','-1'])assert.throws(()=>readConfig({...base,ANALYTICS_API_PORT:value}),/invalid value/);
 assert.equal(readConfig({...base,ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS:'18446744073709551615'}).database_acquire_timeout_ms,18446744073709551615n);
});
test('Analytics credential config keeps only trimmed-token digests and rejects duplicate binding',()=>{
 const credentials=[{source_service:' core ',producer_id:' source-1 ',token:' synthetic-fixture '}];
 const config=readConfig({...base,ANALYTICS_INGESTION_CREDENTIALS_JSON:JSON.stringify(credentials)});
 assert.equal(config.ingestion_credentials[0]!.source_service,'core');assert.equal(config.ingestion_credentials[0]!.producer_id,'source-1');assert.match(config.ingestion_credentials[0]!.token_sha256,/^[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(config).includes('synthetic-fixture'));
 assert.throws(()=>readConfig({...base,ANALYTICS_INGESTION_CREDENTIALS_JSON:JSON.stringify([...credentials,...credentials])}),/invalid credential/);
 assert.throws(()=>readConfig({...base,ANALYTICS_INGESTION_CREDENTIALS_JSON:JSON.stringify([{source_service:'other',producer_id:'source',token:'fixture'}])}),/invalid credential/);
 assert.equal(readConfig({...base,ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON:'[{"source_service":"another-source","token":"fixture"}]'}).reporting_resolver_credentials[0]!.source_service,'another-source');
});
