import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { installPgTimestampParsers } from '../src-ts/db.js';
installPgTimestampParsers();
import { parseCreateBooking,parseCreateService,parseUpdateBooking,parseUpdateService } from '../src-ts/routes/bookings.js';
import { createService,updateService,createBooking,updateBooking,getBooking,listBookings,listServices,requireWorkspaceAdmin } from '../src-ts/services/bookings.js';
import { ensureWhatsappCustomer,ensureMetaCustomer,getCustomerDetail } from '../src-ts/services/customers.js';
import type { RequestContext } from '../src-ts/identity/request-context.js';
function context(orgId:string,userId='owner'):RequestContext{return {principal:{kind:'direct_user',id:userId,subjectUserId:userId,clientId:null},organizationId:orgId,userId,clientId:null,installationId:null,effectiveGrants:new Set(),apiScopes:null,correlationId:null,causationId:null,idempotencyKey:null};}
test('booking transport retains defaults, explicit blank clearing and user-only service administration',async()=>{
 const start='2030-01-01T12:00:00.123456Z';
 assert.deepEqual(parseCreateBooking({serviceId:' service ',contactName:' Ada ',scheduledStart:start,customerId:' ',timezone:' '}),{serviceId:'service',contactName:'Ada',scheduledStart:start,customerId:null,contactPhone:null,timezone:'Africa/Johannesburg',notes:null});
 assert.deepEqual(parseUpdateService({description:null}),{});assert.deepEqual(parseUpdateService({description:' '}),{description:null});assert.deepEqual(parseUpdateBooking({status:' confirmed ',notes:' '}),{status:'CONFIRMED',notes:null});
 for(const durationMinutes of [4,1441])assert.throws(()=>parseCreateService({name:'Consultation',durationMinutes}));
 assert.throws(()=>parseCreateBooking({serviceId:'service',contactName:'Ada',scheduledStart:'not-a-date'}));assert.throws(()=>parseCreateBooking({serviceId:'service',contactName:'Ada',scheduledStart:'2030-02-30T12:00:00Z'}));assert.throws(()=>parseUpdateBooking({status:'published'}));
 const machine={...context('org'),principal:{kind:'agent_installation',id:'agent',subjectUserId:'owner',clientId:null}} as RequestContext;
 await assert.rejects(requireWorkspaceAdmin(machine,{} as pg.Pool),/requires a workspace user/);
});
test('synthetic PostgreSQL booking availability, org isolation, customer identity and joined history',{skip:!process.env.CORE_BOOKINGS_TEST_DATABASE_URL},async()=>{
 const url=process.env.CORE_BOOKINGS_TEST_DATABASE_URL!;const schema=`bookings_test_${randomUUID().replaceAll('-','')}`;const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
 try{
 await pool.query(`CREATE TYPE "BookingStatus" AS ENUM('SCHEDULED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW');
 CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
 CREATE TABLE "BookingService"(id text PRIMARY KEY,"orgId" text,name text,description text,"durationMinutes" integer,active boolean,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "Customer"(id text PRIMARY KEY,"orgId" text,"displayName" text,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "CustomerIdentity"(id text PRIMARY KEY,"orgId" text,"customerId" text,channel text,"scopeId" text,"externalId" text,"identityKey" text,"displayName" text,metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp,UNIQUE("orgId","identityKey"));
 CREATE TABLE "Booking"(id text PRIMARY KEY,"orgId" text,"serviceId" text,"customerId" text,"contactName" text,"contactPhone" text,"scheduledStart" timestamptz,"scheduledEnd" timestamptz,timezone text,status "BookingStatus",notes text,"createdById" text,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "WhatsappContact"(id text,"orgId" text,"customerId" text,phone text,"fullName" text,tags text[],"listLabel" text,"optIn" boolean,"optInSource" text,"optInDate" timestamp,excluded boolean,notes text,"lastMarketingSent" timestamp,"updatedAt" timestamp);
 CREATE TABLE "ExternalConnection"(id text,"orgId" text,"displayName" text);
 CREATE TABLE "Conversation"(id text,channel text,"customerId" text,"orgId" text,"externalConnectionId" text,"customerIdentifier" text,"customerName" text,status text,"lastMessageAt" timestamp,"unreadCount" integer);
 CREATE TABLE "WhatsappCampaign"(id text PRIMARY KEY,"orgId" text,name text,status text,"templateName" text,"sentCount" integer,"deliveredCount" integer,"readCount" integer,"updatedAt" timestamp);
 CREATE TABLE "WhatsappCampaignRecipient"("contactId" text,"campaignId" text,"sentAt" timestamp);
 INSERT INTO "OrganizationMember" VALUES('org-a','owner','OWNER'),('org-a','member','MEMBER'),('org-b','owner','OWNER');`);
 const scope=context('org-a');const service=await createService(pool,scope,parseCreateService({name:' Consultation ',durationMinutes:60,description:' Initial '}));assert.equal(service.name,'Consultation');
 await assert.rejects(createService(pool,context('org-a','member'),parseCreateService({name:'Forbidden',durationMinutes:60})),/Admin or Owner/);
 await assert.rejects(updateService(pool,context('org-b'),service.id,{name:'Foreign'}),/Booking service not found/);
 const customerId=await ensureWhatsappCustomer(pool,'org-a','+271234','Ada');assert.equal(await ensureWhatsappCustomer(pool,'org-a','+271234','Changed'),customerId);
 const foreign=await ensureWhatsappCustomer(pool,'org-b','+271234','Other');assert.notEqual(foreign,customerId);
 const metaA=await ensureMetaCustomer(pool,'org-a','facebook','connection-a','participant','Ada');const metaB=await ensureMetaCustomer(pool,'org-a','facebook','connection-b','participant','Ada');assert.notEqual(metaA,metaB);
 const input=parseCreateBooking({serviceId:service.id,customerId,contactName:'Ada',scheduledStart:'2030-01-01T12:00:00.123456Z',notes:'Notes'});
 await assert.rejects(createBooking(pool,scope,{...input,customerId:foreign}),/Contact does not belong/);
 await assert.rejects(createBooking(pool,context('org-b'),input),/Active booking service not found/);
 const booking=await createBooking(pool,scope,input);assert.equal(booking.serviceName,'Consultation');assert.equal(booking.customerName,'Ada');assert.equal(booking.timezone,'Africa/Johannesburg');assert.equal(booking.scheduledStart.toJSON(),'2030-01-01T12:00:00.123456Z');assert.equal(booking.scheduledEnd.toJSON(),'2030-01-01T13:00:00.123456Z');
 // Rust create_booking has an autocommit INSERT followed by a separate readback;
 // update_booking is one data-modifying CTE. Exercise those actual statement
 // boundaries rather than inventing a broader transaction around validation.
 await pool.query(`CREATE TABLE "BookingFailureAudit"("bookingId" text, operation text);
 CREATE FUNCTION booking_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   IF NEW.notes = '__fixture_force_statement_failure__' THEN
     INSERT INTO "BookingFailureAudit" VALUES(NEW.id,TG_OP);
     RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='synthetic booking statement failure';
   END IF;
   RETURN NEW;
 END;
 $$;
 CREATE TRIGGER booking_fixture_failure AFTER INSERT OR UPDATE ON "Booking"
 FOR EACH ROW EXECUTE FUNCTION booking_fixture_failure();`);
 const rowsBefore = (await pool.query(`SELECT count(*)::int AS count FROM "Booking"`)).rows[0].count;
 const customerBefore = (await pool.query(`SELECT * FROM "Customer" WHERE id=$1`,[customerId])).rows[0];
 await assert.rejects(createBooking(pool,scope,{
   ...input,scheduledStart:'2030-01-02T12:00:00.123456Z',
   notes:'__fixture_force_statement_failure__',
 }), (error:unknown)=>error instanceof Error && error.message === 'synthetic booking statement failure' && (error as Error & {code?:string}).code === 'P0001');
 assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "Booking"`)).rows[0].count, rowsBefore);
 assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "BookingFailureAudit"`)).rows[0].count,0);
 assert.deepEqual((await pool.query(`SELECT * FROM "Customer" WHERE id=$1`,[customerId])).rows[0],customerBefore);
 const beforeFailedUpdate=(await pool.query(`SELECT * FROM "Booking" WHERE id=$1`,[booking.id])).rows[0];
 await assert.rejects(updateBooking(pool,scope,booking.id,{
   status:'CONFIRMED',notes:'__fixture_force_statement_failure__',
 }), (error:unknown)=>error instanceof Error && error.message === 'synthetic booking statement failure' && (error as Error & {code?:string}).code === 'P0001');
 assert.deepEqual((await pool.query(`SELECT * FROM "Booking" WHERE id=$1`,[booking.id])).rows[0],beforeFailedUpdate);
 assert.equal((await pool.query(`SELECT count(*)::int AS count FROM "BookingFailureAudit"`)).rows[0].count,0);
 // The same connection pool remains usable after each rejected statement.
 const recovered=await createBooking(pool,scope,{
   ...input,scheduledStart:'2030-01-02T12:00:00.123456Z',notes:'recovered',
 });
 await pool.query(`DELETE FROM "Booking" WHERE id=$1`,[recovered.id]);
 const precision=(await pool.query(`SELECT EXTRACT(MICROSECONDS FROM "scheduledStart") AS start,EXTRACT(MICROSECONDS FROM "scheduledEnd") AS finish FROM "Booking" WHERE id=$1`,[booking.id])).rows[0];assert.equal(precision.start,'123456');assert.equal(precision.finish,'123456');
 await assert.rejects(createBooking(pool,scope,input),/already has a booking/);
 const original=await updateBooking(pool,scope,booking.id,parseUpdateBooking({status:'cancelled',notes:' '}));assert.equal(original.status,'SCHEDULED');
 assert.equal((await getBooking(pool,'org-a',booking.id))?.status,'CANCELLED');assert.equal((await getBooking(pool,'org-a',booking.id))?.notes,null);
 await createBooking(pool,scope,input);assert.equal((await listBookings(pool,'org-a')).length,2);assert.equal((await listBookings(pool,'org-b')).length,0);
 await updateService(pool,scope,service.id,{active:false});await assert.rejects(createBooking(pool,scope,{...input,scheduledStart:'2030-01-02T12:00:00Z'}),/Active booking service not found/);assert.equal((await listServices(pool,'org-a'))[0]?.active,false);
 await pool.query(`INSERT INTO "WhatsappContact"(id,"orgId","customerId",phone,"fullName","listLabel","optIn",excluded,"updatedAt") VALUES('contact','org-a',$1,'+271234','Ada','All',true,false,NOW());`,[customerId]);await pool.query(`INSERT INTO "ExternalConnection" VALUES('connection','org-a','Page');`);
 await pool.query(`INSERT INTO "Conversation" VALUES('conversation','facebook',$1,'org-a','connection','participant','Ada','OPEN',NOW(),2);`,[customerId]);
 await pool.query(`INSERT INTO "WhatsappCampaign" VALUES('campaign','org-a','Campaign','SENT','Welcome',1,1,0,NOW());INSERT INTO "WhatsappCampaignRecipient" VALUES('contact','campaign',NOW());`);
 const detail=await getCustomerDetail(pool,'org-a',customerId);assert.equal((detail?.bookings as unknown[]).length,2);assert.equal((detail?.bookings as {scheduledStart:Date}[])[0]!.scheduledStart.toJSON(),'2030-01-01T12:00:00.123456Z');assert.equal((detail?.contacts as {optIn:boolean}[])[0]?.optIn,true);assert.equal((detail?.conversations as {connectionLabel:string}[])[0]?.connectionLabel,'Page');assert.equal((detail?.campaigns as {templateName:string}[])[0]?.templateName,'Welcome');assert.deepEqual(detail?.agentEvents,[]);assert.equal(await getCustomerDetail(pool,'org-b',customerId),undefined);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
