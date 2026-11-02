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
  it('parses one whitespace-tolerant rollout policy for every authority boundary',()=>{
    const env={AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS:' org-a, , org-b '};
    expect(memberAssistantPolicy(env)).toEqual({all:false,organizationIds:['org-a','org-b']});
    expect(memberAssistantEnabled('org-b',env)).toBe(true);
    expect(memberAssistantEnabled('org-c',env)).toBe(false);
    expect(memberAssistantEnabled('org-c',{AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS:' * '})).toBe(true);
    expect(memberAssistantEnabled('org-a',{})).toBe(false);
  });
});
