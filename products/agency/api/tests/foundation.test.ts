import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { UtcTimestamp } from '../src/db.js';
import { migrationLockId, readMigrations } from '../src/migrate.js';

test('tenant configuration retains source fallback precedence, cookie and numeric boundaries', () => {
 const config=readConfig({TENANT_DATABASE_URL:' postgres://fixture ',TENANT_SERVER_PORT:'65536',PORT:'+8123',TENANT_SESSION_TTL_HOURS:'4294967296',TENANT_SESSION_COOKIE_SAME_SITE:'BAD',TENANT_PLATFORM_BASE_DOMAIN:' ..Agency.Example.. ',TENANT_APP_BASE_URL:'https://Portal.Example:443/login',TENANT_SERVER_ENVIRONMENT:'Production',TENANT_CORS_ALLOW_CREDENTIALS:'false',ANALYTICS_REPORTING_TIMEOUT_MS:'1'});
 assert.equal(config.port,8123);assert.equal(config.session_ttl_hours,336);
 assert.equal(config.database_url,'postgres://fixture');assert.equal(config.session_cookie_same_site,'lax');
 assert.equal(config.platform_base_domain,'agency.example');assert.equal(config.portal_host_target,'portal.example');
 assert.equal(config.session_cookie_secure,true);assert.equal(config.cors_allow_credentials,false);assert.equal(config.analytics_reporting_timeout_ms,250);
 assert.throws(()=>readConfig({DATABASE_URL:'postgres://not-the-tenant-variable'}),/Missing tenant database/);
});
test('tenant PostgreSQL timestamps retain source microseconds and UTC offset normalization',()=>{
 assert.equal(new UtcTimestamp('2026-10-02 18:20:30.123456',false).toISOString(),'2026-10-02T18:20:30.123456Z');
 assert.equal(new UtcTimestamp('2026-10-02 20:20:30.123456+02',true).toISOString(),'2026-10-02T18:20:30.123456Z');
});
test('native migrations retain all twelve source scripts and append Agency partner migrations',async()=>{
 const migrations=await readMigrations();
 const source=migrations.filter(m=>BigInt(m.version)<20261006090000n);
 assert.equal(source.length,12);
 assert.equal(source[0]!.version,'20260409120000');assert.equal(source.at(-1)!.version,'20260824120000');
 assert.deepEqual(migrations.slice(-2).map(m=>m.version),['20261006090000','20261006110000']);
 assert.ok(migrations.every(m=>m.checksum.length===48&&!m.down&&!m.noTransaction));
 // CRC32('123456789') = cbf43926, the standard ISO-HDLC check value.
 assert.equal(migrationLockId('123456789'),(0xcbf43926n*0x3d32ad9en).toString());
});
