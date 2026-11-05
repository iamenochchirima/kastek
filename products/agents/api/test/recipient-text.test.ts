import { randomUUID } from "node:crypto";
import { expect, it, vi, describe, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { assertRecipientArtifact, explicitlyRequestsPlatformIdentifier, projectRecipientText, projectRecipientMessages, taskRecipientTextScope } from "../src/execution/context/recipient-text";
import { dropClosedTestDatabase } from "./support/database-cleanup";

it("projects known task control values without rewriting business references or user-supplied quotations", async()=>{
  const control="11111111-1111-4111-8111-111111111111", quoted="22222222-2222-4222-8222-222222222222";
  const business="33333333-3333-4333-8333-333333333333";
  const output=`Task ${control}; order ${business}; quote ${quoted}.`;
  const pool={query:vi.fn().mockResolvedValue({rows:[{value:control}]})} as unknown as Pool;
  const scope=await taskRecipientTextScope(pool,control,[output]);
  expect(projectRecipientText(output,scope)).toBe(`Task [internal reference]; order ${business}; quote ${quoted}.`);
});

it("projects a page with one scoped lookup and preserves user messages",async()=>{
  const control="11111111-1111-4111-8111-111111111111",query=vi.fn().mockResolvedValue({rows:[{value:control}]});
  const pool={query} as unknown as Pool;
  const messages=[{role:"user",text:`User wrote ${control}`},{role:"assistant",text:`Task ${control}`},{role:"assistant",text:`Again ${control}`}];
  const result=await projectRecipientMessages(pool,control,messages);
  expect(query).toHaveBeenCalledTimes(1);
  expect(result.map(message=>message.text)).toEqual([`User wrote ${control}`,"Task [internal reference]","Again [internal reference]"]);
});

it("allows a platform ID only when the user explicitly requests it",()=>{
  const id="123456789012345",text=`Page ID ${id}`;
  expect(explicitlyRequestsPlatformIdentifier("What is the Facebook Page ID?" )).toBe(true);
  expect(explicitlyRequestsPlatformIdentifier("Do not include the Page ID" )).toBe(false);
  expect(explicitlyRequestsPlatformIdentifier("Which Facebook Pages are connected?" )).toBe(false);
  expect(projectRecipientText(text,{controlValues:[id],userText:[]})).toBe("Page ID [internal reference]");
  expect(projectRecipientText(text,{controlValues:[id],userText:[],permittedValues:[id]})).toBe(text);
});

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("recipient control provenance",()=>{
  const database=`agents_recipient_text_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,root_task_id uuid,organization_id uuid,conversation_id uuid,principal jsonb,turn_sequence bigint,parent_task_id uuid,version_id uuid,grant_id uuid,input text,product text);
      CREATE TABLE agents_platform.operations(id text,task_id uuid,request jsonb,output jsonb,started_at timestamptz DEFAULT now());
      CREATE TABLE agents_platform.evidence_nodes(id uuid,task_id uuid);
      CREATE TABLE agents_platform.evidence_history_links(node_id uuid,origin_task_id uuid);`);
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("projects only known control values, including inherited connection selectors, while preserving user text",async()=>{
    const org=randomUUID(),conversation=randomUUID(),prior=randomUUID(),child=randomUUID(),task=randomUUID(),idRequestTask=randomUUID();
    const selector="external_connection_123456789",account="social_account_123456789",provider="provider_account_123456789",legacy="legacy_connection_123456789",quoted=randomUUID(),business=randomUUID(),signedUrl="https://media.test/public?signature=secret";
    await pool.query(`INSERT INTO agents_platform.tasks VALUES
      ($1,$1,$3,$4,'{"kind":"human"}',1,NULL,$5,$6,$7,'growth'),
      ($2,$2,$3,$4,'{"kind":"human"}',2,NULL,$8,$9,'Please help','growth'),
      ($10,$10,$3,$4,'{"kind":"human"}',3,NULL,$11,$12,'What is the Facebook Page ID?','growth')`,
      [prior,task,org,conversation,randomUUID(),randomUUID(),`Quote ${quoted} and ${signedUrl}`,randomUUID(),randomUUID(),idRequestTask,randomUUID(),randomUUID()]);
    await pool.query(`INSERT INTO agents_platform.tasks VALUES($1,$2,$3,$4,'{"kind":"human"}',1,$2,$5,$6,'child brief','growth')`,[child,prior,org,conversation,randomUUID(),randomUUID()]);
    await pool.query("INSERT INTO agents_platform.operations(id,task_id,request,output) VALUES($1,$2,$3,$4)",[`tool:${child}`,child,{productOperation:"connections.list"},{value:{state:"succeeded",result:{connections:[{id:selector,displayName:"Test Page"}],pagination:{limit:50,cursor:0,nextCursor:null}}}}]);
    await pool.query("INSERT INTO agents_platform.operations(id,task_id,request,output) VALUES($1,$2,$3,$4)",[`tool:${task}`,task,{productOperation:"content.accounts.list"},{value:{result:{accounts:[{id:account,external_account_id:provider},{id:quoted}]}}}]);
    await pool.query("INSERT INTO agents_platform.operations(id,task_id,request,output) VALUES($1,$2,$3,$4)",[`legacy:${task}`,task,{productOperation:"connections.list"},{value:{result:{encoding:"json",offset:0,chunk:`{"result":{"connections":[{"id":"${legacy}","name":"unfinished`}}}]);
    await pool.query("INSERT INTO agents_platform.operations(id,task_id,request,output) VALUES($1,$2,$3,$4)",[`media:${prior}`,prior,{productOperation:"content.media.preview"},{value:{result:{previewUrl:signedUrl}}}]);
    const output=`${prior} ${selector} ${account} ${provider} ${legacy} ${quoted} ${business} ${signedUrl}`;
    const scope=await taskRecipientTextScope(pool,task,[output]);
    expect(projectRecipientText(output,scope)).toBe(`[internal reference] [internal reference] [internal reference] [internal reference] [internal reference] ${quoted} ${business} [internal reference]`);
    const idOutput=`The Facebook Page ID is ${provider}; internal task ${idRequestTask}.`;
    const idScope=await taskRecipientTextScope(pool,idRequestTask,[idOutput]);
    expect(projectRecipientText(idOutput,idScope)).toBe(`The Facebook Page ID is ${provider}; internal task [internal reference].`);
    const content=Buffer.from(output);
    await expect(assertRecipientArtifact(pool,task,"text/plain",content)).rejects.toMatchObject({code:"ARTIFACT_DISCLOSURE_BLOCKED"});
    expect(content.toString()).toBe(output);
    await expect(assertRecipientArtifact(pool,task,"text/plain",Buffer.from(`Order ${business}`))).resolves.toBeUndefined();
  });
});
