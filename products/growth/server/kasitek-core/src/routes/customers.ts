import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser,resolveActiveOrgId } from '../identity/session.js';
import { getCustomerDetail } from '../services/customers.js';
export function registerCustomerRoutes(app:FastifyInstance,context:CoreContext):void {
 app.get('/api/customers/:id',async request=>{const user=await extractUser(request,context);const orgId=await resolveActiveOrgId(request,context,user.id);const detail=await getCustomerDetail(context.pool,orgId,(request.params as {id:string}).id);if(!detail)throw new ApiError(404,'not_found','Customer not found');return detail;});
}
