import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { SandboxManager, type SandboxScope, type SandboxInput } from "../src/capabilities/sandbox/sandbox";
async function main(){
  const input=JSON.parse(await readFile(process.argv[2]!,"utf8")) as {scope:SandboxScope;request:SandboxInput;configuration:ConstructorParameters<typeof SandboxManager>[1]};
  input.scope.deadlineAt=new Date(input.scope.deadlineAt);
  const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL});
  try{await new SandboxManager(pool,input.configuration).analyze(input.scope,input.request);}finally{await pool.end();}
}
void main().catch(()=>{process.exitCode=1;});
