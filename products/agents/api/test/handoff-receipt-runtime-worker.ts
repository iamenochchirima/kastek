import { createServer } from 'node:http2';
import { createEndpointHandler } from '@restatedev/restate-sdk';
import { Pool } from 'pg';
import { createReceiptWorkflow } from '../src/product/inbox/handoff-pending-receipt-runtime';

async function main() {
  const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL});
  const workflow=createReceiptWorkflow(pool,'fallback',async(db,{receipt,text})=>{
    const id=(await db.query('INSERT INTO agents_platform.customer_messages(id,body) VALUES(gen_random_uuid(),$1) RETURNING id',[text])).rows[0].id;
    process.stdout.write(`RECEIPT_PUBLISHED ${receipt.task_id}\n`);
    return id;
  });
  const server=createServer(createEndpointHandler({services:[workflow]}));
  await new Promise<void>(resolve=>server.listen(Number(process.env.RECEIPT_FIXTURE_PORT),process.env.RECEIPT_FIXTURE_HOST,resolve));
  process.stdout.write('RECEIPT_FIXTURE_READY\n');
}
void main().catch(()=>{process.stderr.write('Receipt fixture failed\n');process.exitCode=1;});
