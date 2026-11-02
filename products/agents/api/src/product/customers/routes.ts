import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {ADMIN_AUTHORITY_HEADER,verifyAdminAuthority,type AdminCapability} from '@kasitek-labs/server-support/admin-authority';
import {parseCustomerOperation,parseCustomerPage,customerOperationsEnabled} from '@kasitek-labs/server-support/admin-customers';
import {PlatformError} from '../../contracts/contracts';
import {AgentsCustomerOperations} from './service';
export function registerAdminCustomerRoutes(app:FastifyInstance,pool:Pool,secret:string|undefined,environment:NodeJS.ProcessEnv=process.env){
 app.register(async app=>{
 const rawBodies=new WeakMap<FastifyRequest,string>();
 app.removeContentTypeParser('application/json');
 app.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:32768},(request,body,done)=>{
  const raw=String(body);rawBodies.set(request,raw);
  try{done(null,JSON.parse(raw));}catch{done(new PlatformError('INVALID_JSON',400,'Invalid JSON'));}
 });
 const service=new AgentsCustomerOperations(pool,environment);
 async function authorize(request:FastifyRequest,capability:AdminCapability){
  if(!customerOperationsEnabled(environment))throw new PlatformError('UNAVAILABLE',404,'Customer operations unavailable');
  const token=request.headers[ADMIN_AUTHORITY_HEADER];
  let actor;
  try{
   if(!secret||typeof token!=='string')throw Error();
   actor=verifyAdminAuthority(token,{secret,audience:'agents',method:request.method,path:request.url,body:rawBodies.get(request)??'',capability});
  }catch{throw new PlatformError('ACCESS_DENIED',403,'Insufficient admin authority');}
  const result=await pool.query(`WITH expired AS (SELECT nonce FROM agents_platform.admin_customer_nonces WHERE expires_at<now() ORDER BY expires_at LIMIT 100), cleared AS (DELETE FROM agents_platform.admin_customer_nonces n USING expired e WHERE n.nonce=e.nonce RETURNING n.nonce) INSERT INTO agents_platform.admin_customer_nonces(nonce,expires_at) VALUES($1,to_timestamp($2::double precision/1000)) ON CONFLICT DO NOTHING`,[actor.nonce,actor.expiresAt]);
  if(!result.rowCount)throw new PlatformError('AUTHORITY_REPLAY',403,'Admin authority already used');
  return actor;
 }
 app.get('/api/admin/customer-links/:product/:customerId',async request=>{await authorize(request,'admin:read');const p=request.params as {product:string;customerId:string};return service.relationships(p.product,p.customerId);});
 const base='/api/admin/customers/:customerId';
 const params=(request:FastifyRequest)=>request.params as {customerId:string;collection:string;operationId:string};
 app.get(base,async request=>{await authorize(request,'admin:read');return service.overview(params(request).customerId);});
 app.get(`${base}/operations/:operationId`,async request=>{await authorize(request,'admin:read');const p=params(request);return service.lookup(p.customerId,p.operationId);});
 app.get(`${base}/:collection`,async request=>{await authorize(request,'admin:read');const p=params(request),page=parseCustomerPage(request.query as Record<string,unknown>);return service.section(p.customerId,p.collection,page.limit,page.cursor);});
 app.post(`${base}/operations/preview`,{bodyLimit:32768},async request=>{await authorize(request,'admin:operate');return service.preview(params(request).customerId,parseCustomerOperation(request.body));});
 app.post(`${base}/operations`,{bodyLimit:32768},async request=>{const actor=await authorize(request,'admin:operate');const receipt=await service.execute(params(request).customerId,actor.id,parseCustomerOperation(request.body));request.log.info({event:'admin.customer.operation',operationId:receipt.id,action:receipt.action,status:receipt.status,code:receipt.code,customerId:receipt.customer.id,actorId:actor.id},'Customer operation recorded');return receipt;});
 });
}
