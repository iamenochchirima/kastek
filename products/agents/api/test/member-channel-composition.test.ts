import { afterEach, describe, expect, it } from "vitest";
import { composeChannels } from "../src/composition/channels";
import { metaSetupProfileDigest, type MetaSetupProfile } from "../src/product/channels/meta-setup";
import { memberAssistantEnabled, memberAssistantPolicy } from "../src/infrastructure/member-assistant-policy";

const previous=process.env.AGENTS_META_CHANNEL_PROFILES;
afterEach(()=>{if(previous===undefined)delete process.env.AGENTS_META_CHANNEL_PROFILES;else process.env.AGENTS_META_CHANNEL_PROFILES=previous;});
const profile:MetaSetupProfile={kind:'whatsapp',mode:'cloud_api',appId:'fixture',appSecret:'fixture-only',webhookVerifyToken:'fixture-only',apiVersion:'v24.0',
  redirectUri:'https://agents.fixture.test/app/connections',scopes:['whatsapp_business_messaging'],subscribedFields:['messages'],embeddedConfigurationId:'fixture',discoveryPageLimit:4};
describe('private member transport composition',()=>{
  it('requires reconnect after a Meta profile change even for verified private members',async()=>{
    process.env.AGENTS_META_CHANNEL_PROFILES=JSON.stringify([profile]);
    const services=composeChannels({} as never,{} as never,'https://agents.fixture.test');
    const connection={kind:'whatsapp',mode:'cloud_api',metadata:{setupProfileDigest:metaSetupProfileDigest(profile)}};
    const message={member_link_id:'fixture-link'};
    const request={assetId:'123',recipientId:'456',text:'Private draft'};
    await expect(services.delivery.ports.assertPolicy(connection,message,request)).resolves.toBeUndefined();
    await expect(services.delivery.ports.assertPolicy({...connection,metadata:{setupProfileDigest:metaSetupProfileDigest({...profile,apiVersion:'v25.0'})}},message,request))
      .rejects.toMatchObject({code:'CHANNEL_RECONNECT_REQUIRED'});
    process.env.AGENTS_META_CHANNEL_PROFILES='[]';
    const unavailable=composeChannels({} as never,{} as never,'https://agents.fixture.test');
    await expect(unavailable.delivery.ports.assertPolicy(connection,message,request)).rejects.toMatchObject({code:'CHANNEL_PROVIDER_UNAVAILABLE'});
  });
  it('applies reply-window policy to Growth-managed messages without requiring a native provider profile',async()=>{
    process.env.AGENTS_META_CHANNEL_PROFILES='[]';
    const latestCustomerAt=new Date(Date.now()-60_000);
    const pool={query:async()=>({rows:[{occurred_at:latestCustomerAt}]})};
    const services=composeChannels(pool as never,{} as never,'https://agents.fixture.test');
    const connection={kind:'facebook',mode:'growth_managed',organization_id:'org-1',id:'connection-1',metadata:{growthLink:{providerMode:'meta'}}};
    const message={conversation_id:'conversation-1',ownership_generation:1,author_account_id:'account-1',author_kind:'human'};
    const request={assetId:'page-1',recipientId:'customer-1',text:'Reply'};
    await expect(services.delivery.ports.assertPolicy(connection,message,request)).resolves.toMatchObject({allowed:true,reason:'standard'});
    await expect(services.delivery.ports.assertPolicy({...connection,metadata:{}},message,request))
      .rejects.toMatchObject({code:'GROWTH_CHANNEL_AUTHORITY_CHANGED'});
  });
  it('parses one whitespace-tolerant rollout policy for every authority boundary',()=>{
    const env={AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS:' org-a, , org-b '};
    expect(memberAssistantPolicy(env)).toEqual({all:false,organizationIds:['org-a','org-b']});
    expect(memberAssistantEnabled('org-b',env)).toBe(true);
    expect(memberAssistantEnabled('org-c',env)).toBe(false);
    expect(memberAssistantEnabled('org-c',{AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS:' * '})).toBe(true);
    expect(memberAssistantEnabled('org-a',{})).toBe(false);
  });
});
