import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { importSPKI,jwtVerify } from 'jose';
import { parseLosslessJson } from '@kasitek-labs/server-support/json';
import { ReportingClientError } from '@kasitek-labs/server-support/analytics-reporting';
import { parseReportQuery } from '../src-ts/routes/analytics.js';
import { mapReportingError,reportForOrganization } from '../src-ts/services/analytics-reporting.js';
import { MAX_GRANT_SECONDS } from '@kasitek-labs/contracts';
import { readConfig } from '../src-ts/config.js';
import type { CoreContext } from '../src-ts/context.js';
test('report input keeps Rust defaults and rejects extra scope fields or malformed contract values',()=>{
 const query=parseReportQuery({range_start:'2030-01-01T00:00:00.123456Z',range_end:'2030-02-01T00:00:00Z',timezone:'Africa/Johannesburg'});
 assert.deepEqual(query.metrics,[]);assert.deepEqual(query.filters,{});assert.equal(query.include_descendants,false);assert.equal(query.range_start,'2030-01-01T00:00:00.123456Z');
 for(const extra of [{reporting_scope_id:999},{filters:null},{metrics:null},{breakdowns:['good',1]},{comparison:{kind:'previous_period',unsafe:1}},{include_descendants:'yes'}])assert.throws(()=>parseReportQuery({...query,...extra}));
 for(const [status,expected] of [[400,400],[422,400],[401,502],[403,502],[404,503],[500,503]] as const){const mapped=mapReportingError(new ReportingClientError(status,'secret upstream detail'));assert.equal(mapped.status,expected);assert.ok(!mapped.message.includes('secret'));}
 assert.equal(mapReportingError(new SyntaxError('unsafe body')).status,502);
});
test('report timestamps accept Chrono separators and offsets while rejecting invalid dates',()=>{
 const query=parseReportQuery({range_start:'2030-01-01 01:30:00.123456+0130',range_end:'2030-01-01T01:30:60.000001+0130',timezone:'UTC'});
 assert.equal(query.range_start,'2030-01-01T00:00:00.123456Z');
 assert.equal(query.range_end,'2030-01-01T00:00:60.000001Z');
 for(const range_start of ['2030-02-30T00:00:00Z','2030-01-01T24:00:00Z','2030-01-01T00:00:00+24:00'])assert.throws(()=>parseReportQuery({range_start,range_end:'2030-01-02T00:00:00Z',timezone:'UTC'}));
});
test('fixture Analytics receives only server-resolved organization grants and raw scope ID is redacted',async()=>{
 const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const privateKey=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();const publicKey=await importSPKI(keys.publicKey.export({type:'spki',format:'pem'}).toString(),'ES256');
 const observed:{path:string;authorization:string;source?:string;body?:unknown}[]=[];let upstreamStatus=200;let invalidResponse=false;
 const server=createServer((request,response)=>{const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{const url=new URL(request.url!,'http://fixture');observed.push({path:url.pathname,authorization:request.headers.authorization??'',source:request.headers['x-source-service'] as string|undefined,body:chunks.length?parseLosslessJson(Buffer.concat(chunks).toString()):undefined});response.writeHead(upstreamStatus,{'content-type':'application/json'});if(upstreamStatus!==200){response.end(JSON.stringify({error:'secret upstream detail'}));return;}if(url.pathname==='/internal/reporting/scopes/resolve'){assert.equal(url.searchParams.get('scope_kind'),'core_organization');assert.equal(url.searchParams.get('external_source_id'),'organization-safe');response.end(JSON.stringify({scope_id:17,root_scope_id:17,scope_kind:'core_organization',owning_source_service:'core',external_source_id:'organization-safe',parent_scope_id:null,reporting_timezone:'UTC'}));return;}response.end(invalidResponse?'invalid json':JSON.stringify({scope_id:17,metrics:[],value:42}));});});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=server.address();assert.ok(address&&typeof address==='object');const context={config:readConfig({DATABASE_URL:'postgres://unused',ANALYTICS_REPORTING_URL:`http://127.0.0.1:${address.port}`,ANALYTICS_REPORTING_RESOLVER_TOKEN:'resolver-private-fixture',ANALYTICS_REPORTING_PRIVATE_KEY:privateKey,ANALYTICS_REPORTING_KEY_ID:'test-key'})} as CoreContext;
 const result=await reportForOrganization(context,'user-safe','organization-safe') as Record<string,unknown>;assert.deepEqual(result.scope,{kind:'core_organization',externalId:'organization-safe'});assert.equal(result.scope_id,undefined);
 assert.equal(observed[0]!.authorization,'Bearer resolver-private-fixture');assert.equal(observed[0]!.source,'core');
 const verified=await jwtVerify(observed[1]!.authorization.slice(7),publicKey,{issuer:'kasitek-core',audience:'kasitek-analytics-reporting',algorithms:['ES256']});assert.equal(verified.payload.sub,'user-safe');assert.equal(verified.payload.scope_id,17);assert.equal(verified.payload.descendant_mode,'none');assert.deepEqual(verified.payload.permissions,['analytics:read']);assert.deepEqual(verified.payload.metric_keys,[]);assert.equal((verified.payload.exp!-verified.payload.iat!),MAX_GRANT_SECONDS);
 const query=parseReportQuery({range_start:'2030-01-01T00:00:00Z',range_end:'2030-02-01T00:00:00Z',timezone:'UTC',metrics:['campaign.recipients.sent']});await reportForOrganization(context,'user-safe','organization-safe',query);assert.equal((observed.at(-1)!.body as Record<string,unknown>).reporting_scope_id,17);assert.equal((observed.at(-1)!.body as Record<string,unknown>).include_descendants,false);
 upstreamStatus=404;await assert.rejects(reportForOrganization(context,'user-safe','organization-safe'),/scope is not ready/);upstreamStatus=200;invalidResponse=true;await assert.rejects(reportForOrganization(context,'user-safe','organization-safe'),/returned an invalid response/);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
