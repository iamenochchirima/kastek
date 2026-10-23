import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantContext } from '../context.js';
import { customerOperationsEnabled, parseCustomerOperation, parseCustomerPage } from '@kasitek-labs/server-support/admin-customers';
import { requireServiceAdmin } from '../admin-authority.js';
import { bad, forbidden, missing } from '../error.js';
import { customerOperationsEnvironment, agencyCustomerOverview, agencyCustomerCollection, performAgencyCustomerOperation, previewAgencyCustomerOperation, readAgencyCustomerOperation } from '../admin-customers.js';

export function registerAdminCustomerRoutes(app:FastifyInstance,context:TenantContext) {
  async function authorize(request:FastifyRequest,capability:'admin:read'|'admin:operate') {
    const actor=await requireServiceAdmin(request,context);
    if(actor.capability!==capability)throw forbidden();
    if(!customerOperationsEnabled(customerOperationsEnvironment(context)))throw missing('customer operations disabled');
    return actor;
  }
  function scope(request:FastifyRequest) {
    const {customerId} = request.params as {customerId:string};
    if(!customerId||customerId.length>200)throw bad('invalid customer');
    return customerId;
  }
  function command(request:FastifyRequest) {
    try{return parseCustomerOperation(request.body);}
    catch{throw bad('invalid customer operation');}
  }
  app.get('/api/admin/customers/:customerId',async request=>{
    await authorize(request,'admin:read');
    return agencyCustomerOverview(context,scope(request));
  });
  app.get('/api/admin/customers/:customerId/operations/:operationId',async request=>{
    await authorize(request,'admin:read');
    return readAgencyCustomerOperation(context,scope(request),(request.params as {operationId:string}).operationId);
  });
  app.get('/api/admin/customers/:customerId/:collection',async request=>{
    await authorize(request,'admin:read');
    let page;try{page=parseCustomerPage(request.query as Record<string,unknown>);}catch{throw bad('invalid page');}
    return agencyCustomerCollection(context,scope(request),(request.params as {collection:string}).collection,page);
  });
  app.post('/api/admin/customers/:customerId/operations/preview',async request=>{
    await authorize(request,'admin:operate');
    return previewAgencyCustomerOperation(context,scope(request),command(request));
  });
  app.post('/api/admin/customers/:customerId/operations',async request=>{
    const actor=await authorize(request,'admin:operate');
    const result=await performAgencyCustomerOperation(context,scope(request),actor.id,command(request));
    request.log.info({event:'admin.customer_operation',service:'agency',actor_id:actor.id,customer_id:result.customer.id,operation_id:result.id,action:result.action,status:result.status,code:result.code,request_id:request.id},'Customer operation');
    return result;
  });
}
