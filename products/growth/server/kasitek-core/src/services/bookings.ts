import { createId } from '@paralleldrive/cuid2';
import type { Pool } from 'pg';
import { ApiError } from '../error.js';
import type { RequestContext } from '../identity/request-context.js';
import { requireAdmin } from './orgs.js';
export interface BookingService { id:string;orgId:string;name:string;description:string|null;durationMinutes:number;active:boolean;createdAt:Date;updatedAt:Date }
export interface Booking {id:string;orgId:string;serviceId:string;serviceName:string;customerId:string|null;customerName:string|null;contactName:string;contactPhone:string|null;scheduledStart:Date;scheduledEnd:Date;timezone:string;status:string;notes:string|null;createdAt:Date;updatedAt:Date}
export interface CreateServiceInput{name:string;description:string|null;durationMinutes:number}
export interface UpdateServiceInput{name?:string;description?:string|null;durationMinutes?:number;active?:boolean}
export interface CreateBookingInput{serviceId:string;customerId:string|null;contactName:string;contactPhone:string|null;scheduledStart:string;timezone:string;notes:string|null}
export interface UpdateBookingInput{status?:string;notes?:string|null}
export const VALID_BOOKING_STATUSES=['SCHEDULED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW'];
const bad=(message:string)=>new ApiError(400,'bad_request',message);
const missing=(message:string)=>new ApiError(404,'not_found',message);
export function requiredText(value:string,label:string):string {const normalized=value.trim();if(!normalized)throw bad(`${label} is required`);return normalized;}
export function validateDuration(value:number):void {if(!Number.isInteger(value)||value<5||value>1440)throw bad('Duration must be between 5 and 1440 minutes');}
export function timestampMilliseconds(value:string):number {
 const leap=/:(60)([.,]\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value);
 return new Date(leap?value.replace(/:60(?=(?:[.,]\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$)/,':59'):value).getTime()+(leap?1000:0);
}
export function validateFutureStart(value:string,now=Date.now()):void {if(!(timestampMilliseconds(value)>now))throw bad('Bookings must be scheduled in the future');}
export function normalizeStatus(value:string):string {const status=value.trim().replace(/[a-z]/g,char=>char.toUpperCase());if(!VALID_BOOKING_STATUSES.includes(status))throw bad('Invalid booking status');return status;}
export async function requireWorkspaceAdmin(context:RequestContext,pool:Pool):Promise<void> {if(context.principal.kind!=='direct_user'||!context.userId)throw new ApiError(403,'forbidden','Booking service administration requires a workspace user');await requireAdmin(pool,context.organizationId,context.userId);}
const SERVICE_COLUMNS='id,"orgId",name,description,"durationMinutes",active,"createdAt","updatedAt"';
const BOOKING_SELECT=`SELECT b.id,b."orgId",b."serviceId",service.name AS "serviceName",b."customerId",customer."displayName" AS "customerName",b."contactName",b."contactPhone",b."scheduledStart",b."scheduledEnd",b.timezone,b.status::text AS status,b.notes,b."createdAt",b."updatedAt" FROM "Booking" b JOIN "BookingService" service ON service.id=b."serviceId" LEFT JOIN "Customer" customer ON customer.id=b."customerId" AND customer."orgId"=b."orgId"`;
export async function listServices(pool:Pool,orgId:string):Promise<BookingService[]> {return (await pool.query<BookingService>(`SELECT ${SERVICE_COLUMNS} FROM "BookingService" WHERE "orgId"=$1 ORDER BY active DESC,name ASC`,[orgId])).rows;}
export async function createService(pool:Pool,context:RequestContext,input:CreateServiceInput):Promise<BookingService> {await requireWorkspaceAdmin(context,pool);const name=requiredText(input.name,'Service name');validateDuration(input.durationMinutes);return (await pool.query<BookingService>(`INSERT INTO "BookingService"(id,"orgId",name,description,"durationMinutes",active,"createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,true,NOW(),NOW()) RETURNING ${SERVICE_COLUMNS}`,[createId(),context.organizationId,name,input.description,input.durationMinutes])).rows[0]!;}
export async function updateService(pool:Pool,context:RequestContext,serviceId:string,input:UpdateServiceInput):Promise<BookingService> {await requireWorkspaceAdmin(context,pool);const name=input.name===undefined?null:requiredText(input.name,'Service name');if(input.durationMinutes!==undefined)validateDuration(input.durationMinutes);const row=(await pool.query<BookingService>(`UPDATE "BookingService" SET name=COALESCE($1,name),description=CASE WHEN $2 THEN $3 ELSE description END,"durationMinutes"=COALESCE($4,"durationMinutes"),active=COALESCE($5,active),"updatedAt"=NOW() WHERE id=$6 AND "orgId"=$7 RETURNING ${SERVICE_COLUMNS}`,[name,input.description!==undefined,input.description??null,input.durationMinutes??null,input.active??null,serviceId,context.organizationId])).rows[0];if(!row)throw missing('Booking service not found');return row;}
export async function listBookings(pool:Pool,orgId:string):Promise<Booking[]> {return (await pool.query<Booking>(`${BOOKING_SELECT} WHERE b."orgId"=$1 ORDER BY b."scheduledStart" ASC`,[orgId])).rows;}
export async function listBookingsForCustomer(pool:Pool,orgId:string,customerId:string):Promise<Booking[]> {return (await pool.query<Booking>(`${BOOKING_SELECT} WHERE b."orgId"=$1 AND b."customerId"=$2 ORDER BY b."scheduledStart" DESC`,[orgId,customerId])).rows;}
export async function getBooking(pool:Pool,orgId:string,bookingId:string):Promise<Booking|undefined> {return (await pool.query<Booking>(`${BOOKING_SELECT} WHERE b.id=$1 AND b."orgId"=$2`,[bookingId,orgId])).rows[0];}
export async function createBooking(pool:Pool,context:RequestContext,input:CreateBookingInput):Promise<Booking> {
 const serviceId=requiredText(input.serviceId,'Service');const contactName=requiredText(input.contactName,'Contact name');validateFutureStart(input.scheduledStart);if(!context.userId)throw new ApiError(403,'forbidden','Booking creation requires a workspace user');
 const service=(await pool.query('SELECT "durationMinutes" FROM "BookingService" WHERE id=$1 AND "orgId"=$2 AND active=true',[serviceId,context.organizationId])).rows[0];if(!service)throw missing('Active booking service not found');
 if(input.customerId&&!(await pool.query('SELECT id FROM "Customer" WHERE id=$1 AND "orgId"=$2',[input.customerId,context.organizationId])).rows[0])throw bad('Contact does not belong to this workspace');
 // PostgreSQL arithmetic retains sub-millisecond precision in the input timestamp.
 const overlaps=(await pool.query(`SELECT EXISTS(SELECT 1 FROM "Booking" WHERE "serviceId"=$1 AND "orgId"=$4 AND status NOT IN('CANCELLED'::"BookingStatus",'NO_SHOW'::"BookingStatus") AND "scheduledStart"<$2::timestamptz+make_interval(mins=>$3) AND "scheduledEnd">$2::timestamptz) AS overlaps`,[serviceId,input.scheduledStart,service.durationMinutes,context.organizationId])).rows[0].overlaps;
 if(overlaps)throw new ApiError(409,'conflict','This service already has a booking in that time slot');
 const id=createId();await pool.query(`INSERT INTO "Booking"(id,"orgId","serviceId","customerId","contactName","contactPhone","scheduledStart","scheduledEnd",timezone,status,notes,"createdById","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz+make_interval(mins=>$8),$9,'SCHEDULED'::"BookingStatus",$10,$11,NOW(),NOW())`,[id,context.organizationId,serviceId,input.customerId,contactName,input.contactPhone,input.scheduledStart,service.durationMinutes,input.timezone,input.notes,context.userId]);
 const row=await getBooking(pool,context.organizationId,id);if(!row)throw new ApiError(500,'internal_error','Created booking could not be loaded');return row;
}
export async function updateBooking(pool:Pool,context:RequestContext,bookingId:string,input:UpdateBookingInput):Promise<Booking> {
 const status=input.status===undefined?null:normalizeStatus(input.status);
 // Keep the Rust data-modifying CTE contract; its SELECT observes the original snapshot.
 const row=(await pool.query<Booking>(`WITH updated AS(UPDATE "Booking" SET status=COALESCE($1::"BookingStatus",status),notes=CASE WHEN $2 THEN $3 ELSE notes END,"updatedAt"=NOW() WHERE id=$4 AND "orgId"=$5 RETURNING id) ${BOOKING_SELECT} WHERE b.id IN(SELECT id FROM updated)`,[status,input.notes!==undefined,input.notes??null,bookingId,context.organizationId])).rows[0];if(!row)throw missing('Booking not found');return row;
}
