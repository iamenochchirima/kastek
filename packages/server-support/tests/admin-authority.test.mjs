import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminAuthority, verifyAdminAuthority, adminCapabilities } from '../dist/admin-authority.js';
const base={secret:'synthetic-secret-with-at-least-32-bytes',audience:'agency',method:'PATCH',path:'/api/admin/workspaces/test?q=1',body:'{"status":"active"}',now:1000000};
test('admin service assertions bind audience, actor, target, body, permissions and time',()=>{
 const token=createAdminAuthority({...base,actor:{id:'operator-1',role:'operator'}});
 assert.equal(verifyAdminAuthority(token,base).id,'operator-1');
 for(const altered of [{audience:'agents'},{method:'GET'},{path:'/api/admin/workspaces/test?q=2'},{body:'{}'},{secret:'different-secret-with-at-least-32-bytes'},{now:base.now+60000},{now:base.now-6000}]) assert.throws(()=>verifyAdminAuthority(token,{...base,...altered}));
 assert.throws(()=>createAdminAuthority({...base,actor:{id:'viewer-1',role:'viewer'}}));
 assert.throws(()=>createAdminAuthority({...base,secret:'',actor:{id:'owner',role:'owner'}}));
 assert.equal(adminCapabilities('owner').has('admin:export'),true);
 assert.equal(adminCapabilities('viewer').has('admin:report'),true);
 assert.equal(adminCapabilities('viewer').has('admin:export'),false);
});
