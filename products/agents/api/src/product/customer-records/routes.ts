import type {FastifyInstance,FastifyRequest} from "fastify";
import type {ActionScope} from "../../contracts/connections";
import {recordCommandSchema} from "../../contracts/customer-records";
import {CustomerRecordStore} from "./store";
export function registerCustomerRecordRoutes(app:FastifyInstance,options:{store:CustomerRecordStore;resolveScope(request:FastifyRequest):Promise<ActionScope>}){
 const base='/api/organizations/:organizationId/customer-records',id=(request:FastifyRequest)=>(request.params as {id:string}).id;
 const log=(request:FastifyRequest,kind:string,recordId:string)=>request.log.info({event:'customer.record.command',kind,recordId},'Customer record command completed');
 app.get(`${base}/members`,async request=>({members:await options.store.members(await options.resolveScope(request))}));
 app.get(`${base}/enquiries`,async request=>options.store.list(await options.resolveScope(request),request.query));
 app.get(`${base}/enquiries/:id`,async request=>({enquiry:await options.store.read(await options.resolveScope(request),id(request))}));
 app.get(`${base}/enquiries/:id/activity`,async request=>options.store.activity(await options.resolveScope(request),id(request),request.query));
 app.post(`${base}/enquiries`,async request=>{const enquiry=await options.store.create(await options.resolveScope(request),request.body);log(request,'create-enquiry',enquiry.id);return {enquiry};});
 app.post(`${base}/enquiries/:id/commands`,async request=>{const input=recordCommandSchema.parse(request.body),enquiry=await options.store.command(await options.resolveScope(request),id(request),input);log(request,input.action,enquiry.id);return {enquiry};});
 app.get(`${base}/contacts`,async request=>options.store.contacts(await options.resolveScope(request),request.query));
 app.get(`${base}/contacts/:id`,async request=>options.store.contact(await options.resolveScope(request),id(request)));
 app.post(`${base}/contacts`,async request=>{const contact=await options.store.createContact(await options.resolveScope(request),request.body);log(request,'create-contact',contact.id);return {contact};});
 app.post(`${base}/contacts/:id/commands`,async request=>{const contact=await options.store.correctContact(await options.resolveScope(request),id(request),request.body);log(request,'correct-contact',contact.id);return {contact};});
}
