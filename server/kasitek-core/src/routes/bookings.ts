import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { resolveProductContext } from '../identity/request-context.js';
import * as bookings from '../services/bookings.js';
function input(request:FastifyRequest):Record<string,unknown>{if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw new ApiError(400,'bad_request','Invalid request');return request.body as Record<string,unknown>;}
function optionalText(value:unknown):string|undefined {if(value==null)return undefined;if(typeof value!=='string')throw new ApiError(400,'bad_request','Invalid request');return value;}
function normalized(value:unknown):string|null{return optionalText(value)?.trim()||null;}
function optionalInteger(value:unknown):number|undefined {if(value==null)return undefined;if(typeof value!=='number'||!Number.isInteger(value)||value< -2147483648||value>2147483647)throw new ApiError(400,'bad_request','Invalid request');return value;}
function optionalBoolean(value:unknown):boolean|undefined {if(value==null)return undefined;if(typeof value!=='boolean')throw new ApiError(400,'bad_request','Invalid request');return value;}
export function parseCreateService(value:Record<string,unknown>):bookings.CreateServiceInput {const name=bookings.requiredText(optionalText(value.name)??'','Service name');const duration=optionalInteger(value.durationMinutes);if(duration===undefined)throw new ApiError(400,'bad_request','Duration must be between 5 and 1440 minutes');bookings.validateDuration(duration);return {name,description:normalized(value.description),durationMinutes:duration};}
export function parseUpdateService(value:Record<string,unknown>):bookings.UpdateServiceInput {const name=optionalText(value.name);const description=optionalText(value.description);const durationMinutes=optionalInteger(value.durationMinutes);if(durationMinutes!==undefined)bookings.validateDuration(durationMinutes);return {...(name!==undefined?{name:bookings.requiredText(name,'Service name')}:{}),...(description!==undefined?{description:description.trim()||null}:{}),...(durationMinutes!==undefined?{durationMinutes}:{}),...(optionalBoolean(value.active)!==undefined?{active:optionalBoolean(value.active)}:{})};}
function validTimestamp(value:string):boolean {
 const match=/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match)return false;const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);const days=[31,(year%4===0&&(year%100!==0||year%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
 return month>=1&&month<=12&&day>=1&&day<=days[month-1]!&&Number(match[4])<=23&&Number(match[5])<=59&&Number(match[6])<=60&&Number.isFinite(bookings.timestampMilliseconds(value));
}
export function parseCreateBooking(value:Record<string,unknown>):bookings.CreateBookingInput {const serviceId=bookings.requiredText(optionalText(value.serviceId)??'','Service');const contactName=bookings.requiredText(optionalText(value.contactName)??'','Contact name');const scheduledStart=bookings.requiredText(optionalText(value.scheduledStart)??'','Start time');if(!validTimestamp(scheduledStart))throw new ApiError(400,'bad_request','Start time must be a valid ISO-8601 timestamp');bookings.validateFutureStart(scheduledStart);return {serviceId,contactName,scheduledStart,customerId:normalized(value.customerId),contactPhone:normalized(value.contactPhone),timezone:normalized(value.timezone)??'Africa/Johannesburg',notes:normalized(value.notes)};}
export function parseUpdateBooking(value:Record<string,unknown>):bookings.UpdateBookingInput {const status=normalized(value.status);const notes=optionalText(value.notes);return {...(status?{status:bookings.normalizeStatus(status)}:{}),...(notes!==undefined?{notes:notes.trim()||null}:{})};}
export function registerBookingRoutes(app:FastifyInstance,context:CoreContext):void {
 app.get('/api/bookings',async request=>{const scope=await resolveProductContext(request,context);return {bookings:await bookings.listBookings(context.pool,scope.organizationId)};});
 app.post('/api/bookings',async(request,reply)=>{const scope=await resolveProductContext(request,context);return reply.code(201).send({booking:await bookings.createBooking(context.pool,scope,parseCreateBooking(input(request)))});});
 app.patch('/api/bookings/:id',async request=>{const scope=await resolveProductContext(request,context);return {booking:await bookings.updateBooking(context.pool,scope,(request.params as {id:string}).id,parseUpdateBooking(input(request)))};});
 app.get('/api/bookings/services',async request=>{const scope=await resolveProductContext(request,context);return {services:await bookings.listServices(context.pool,scope.organizationId)};});
 app.post('/api/bookings/services',async(request,reply)=>{const scope=await resolveProductContext(request,context);return reply.code(201).send({service:await bookings.createService(context.pool,scope,parseCreateService(input(request)))});});
 app.patch('/api/bookings/services/:id',async request=>{const scope=await resolveProductContext(request,context);return {service:await bookings.updateService(context.pool,scope,(request.params as {id:string}).id,parseUpdateService(input(request)))};});
}
