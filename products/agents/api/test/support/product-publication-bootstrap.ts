import {generateKeyPair,exportPKCS8} from "jose";
import {Pool} from "pg";
import {GrowthProductRuntime} from "../../src/execution/products/growth-runtime";
import {GrowthActionClient} from "../../src/adapters/products/growth-action-client";
import {loadExecution} from "../../src/execution/lifecycle/execution";
async function main(){
const pool=new Pool({connectionString:process.env.AGENTS_PUBLICATION_FIXTURE_DATABASE_URL});
try{
 const key=await generateKeyPair("RS256",{extractable:true});
 const runtime=new GrowthProductRuntime(pool,new GrowthActionClient({origin:"http://127.0.0.1:9",issuer:"https://agents.fixture.test",keyId:"fixture",privateKey:await exportPKCS8(key.privateKey),environment:"test"}));
 await runtime.loadPublications("00000000-0000-4000-8000-000000000000");
 await runtime.prepareExecution(process.env.AGENTS_PUBLICATION_FIXTURE_TASK_ID!);
 const execution=await loadExecution(pool,process.env.AGENTS_PUBLICATION_FIXTURE_TASK_ID!);
 process.stdout.write(JSON.stringify({program:execution.configuration.program,bindings:execution.configuration.productBindings.length}));
}finally{await pool.end();}

}
void main().catch(()=>{process.stderr.write("Fresh publication bootstrap failed\n");process.exitCode=1;});
