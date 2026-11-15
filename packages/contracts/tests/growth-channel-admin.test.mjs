import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  growthChannelAdminRequestSchema,
  growthChannelAdminResponseSchema,
  parseGrowthChannelAdminRequest,
  parseGrowthChannelAdminResponse,
} from '../dist/index.js';

const requestId='e6f3a22f-daf6-4349-a928-5147abc46d93';
const actor={issuer:'https://growth.example.test/identity',subject:'growth-user-1'};
const base={version:'1',requestId,actor,growthOrganizationId:'growth-tenant-1'};
const connectionId='5a7a3f5c-9d0b-4f2e-8a6c-1b2c3d4e5f60';
const agentId='9b8c7d6e-5f4a-4b3c-8d2e-1f0a9b8c7d6e';
const botToken='123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';

test('channel administration accepts the documented Growth operations',()=>{
  const cases=[
    {operation:'telegram.connect',name:'Growth assistant',botToken},
    {operation:'telegram.health',connectionId,expectedRevision:2},
    {operation:'telegram.rotate',connectionId,expectedRevision:2,botToken},
    {operation:'telegram.disconnect',connectionId,expectedRevision:2},
    {operation:'channel.list'},
    {operation:'assistant.target'},
    {operation:'channel.bind',connectionId,expectedRevision:2},
    {operation:'channel.unbind',connectionId},
    {operation:'growth.link',provider:'whatsapp',connectionId:'growth-connection-1',providerAssetId:'1074164405768729',
      permissionRevision:'revision-1',name:'WhatsApp',providerMode:'meta',grantId:connectionId,intentId:agentId,
      growthRequestId:requestId,exchangeRequestId:connectionId},
    {operation:'growth.unlink',connectionId},
  ];
  for(const item of cases)assert.deepEqual(parseGrowthChannelAdminRequest({...base,...item}),{...base,...item});
});

test('channel administration rejects unknown fields, operations and credentials',()=>{
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'channel.list',extra:true}));
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'channel.delete'}));
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'telegram.connect',name:'Growth',botToken:'not-a-token'}));
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'telegram.health',connectionId,expectedRevision:0}));
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'channel.bind',connectionId,expectedRevision:2,agentId:'not-an-id'}));
  assert.throws(()=>parseGrowthChannelAdminRequest({...base,operation:'growth.unlink',connectionId,force:true}));
});

test('channel administration responses are bounded and identified',()=>{
  const connection={id:connectionId,organizationId:agentId,kind:'telegram',name:'Growth assistant',
    assetId:'123456',mode:'bot',state:'active',revision:2,credentialRevision:1,metadata:{botUsername:'growth_bot'},
    createdAt:'2026-11-15T10:00:00.000Z',updatedAt:'2026-11-15T10:00:01.000Z'};
  const response={version:'1',requestId,operation:'telegram.connect',connection,status:'active'};
  assert.deepEqual(parseGrowthChannelAdminResponse(response),response);
  assert.deepEqual(parseGrowthChannelAdminResponse({version:'1',requestId,operation:'channel.list',connections:[],deployments:[]}),
    {version:'1',requestId,operation:'channel.list',connections:[],deployments:[]});
  assert.throws(()=>growthChannelAdminResponseSchema.parse({...response,operation:''}));
  assert.throws(()=>growthChannelAdminResponseSchema.parse({...response,unknown:true}));
  assert.throws(()=>growthChannelAdminRequestSchema.parse(base));
});
