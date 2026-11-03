import { spawn } from "node:child_process";
import { readFile, lstat, open, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

function psql(sql: string, service?: string): Promise<string> {
  if(service&&!/^[a-zA-Z0-9_.-]+$/.test(service))throw new Error("Invalid database service");
  const environment={...process.env};
  if(!service&&process.env.AGENTS_DATABASE_URL){
    const url=new URL(process.env.AGENTS_DATABASE_URL);
    if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error("Invalid database URL");
    delete environment.PGSERVICE;
    environment.PGHOST=url.hostname.replace(/^\[|\]$/g,"");environment.PGPORT=url.port||"5432";
    environment.PGUSER=decodeURIComponent(url.username);environment.PGDATABASE=decodeURIComponent(url.pathname.slice(1));
    if(url.password)environment.PGPASSWORD=decodeURIComponent(url.password);
    const parameters:Record<string,string>={host:"PGHOST",port:"PGPORT",user:"PGUSER",dbname:"PGDATABASE",sslmode:"PGSSLMODE",sslrootcert:"PGSSLROOTCERT",sslcert:"PGSSLCERT",sslkey:"PGSSLKEY",options:"PGOPTIONS",application_name:"PGAPPNAME",connect_timeout:"PGCONNECT_TIMEOUT"};
    for(const [key,value] of url.searchParams){if(!parameters[key])throw new Error("Unsupported database URL option");environment[parameters[key]!]=value;}
  }
  environment.PGCONNECT_TIMEOUT??="10";
  if(!service&&!environment.PGDATABASE)throw new Error("Database service or AGENTS_DATABASE_URL is required");
  return new Promise((done,fail)=>{
    const child=spawn("psql",[...(service?[`service=${service}`]:[]),"-w","-X","-qAt","--set","ON_ERROR_STOP=1","--set","VERBOSITY=sqlstate"],{env:environment,stdio:["pipe","pipe","pipe"]});
    let output="",state:string|undefined;child.stdout.setEncoding("utf8");child.stdout.on("data",data=>{output+=data;});
    child.stderr.setEncoding("utf8");child.stderr.on("data",data=>{state??=String(data).match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1];});
    child.on("error",()=>fail(new Error("RETENTION_DATABASE_UNAVAILABLE")));
    child.on("close",code=>code===0?done(output.trim()):fail(new Error("RETENTION_COMMAND_FAILED_"+(state??code))));
    child.stdin.on("error",()=>{});child.stdin.end(sql);
  });
}
export async function retentionLedgerCommand(args: string[]): Promise<void> {
  const [command,...options]=args,values=new Map<string,string>();
  if(options.length%2)throw new Error("Expected named options");
  for(let i=0;i<options.length;i+=2){if(values.has(options[i]!))throw new Error("Duplicate option");values.set(options[i]!,options[i+1]!);}
  const allowed=command==="export"?["--output","--database-service"]:command==="replay"?["--ledger","--database-service"]:
    command==="set-policy"?["--organization","--days","--database-service","--operator"]:[];
  if(!allowed.length||[...values.keys()].some(key=>!allowed.includes(key)))throw new Error("Invalid retention command");
  const service=values.get("--database-service");
  if(command==="export"){
    const path=values.get("--output");if(!path)throw new Error("Output file required");
    const content=await psql(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SELECT jsonb_build_object('version',1,'exportedAt',clock_timestamp(),'complete',true,
        'conversations',agents_platform.export_conversation_deletion_ledger(),
        'memory',agents_platform.export_memory_deletion_ledger()); COMMIT;`,service);
    const output=resolve(path),temporary=output+"."+randomUUID()+".tmp",file=await open(temporary,"wx",0o600);
    try{await file.writeFile(content+"\n");await file.sync();}finally{await file.close();}
    try{await rename(temporary,output);}catch(error){await unlink(temporary);throw error;}
  }else if(command==="replay"){
    const path=values.get("--ledger");if(!path)throw new Error("Ledger file required");
    const stat=await lstat(path);if(!stat.isFile()||(stat.mode&0o077)!==0)throw new Error("Ledger must be a private regular file");
    const content=await readFile(path,"utf8"),ledger=JSON.parse(content);
    const age=Date.now()-Date.parse(ledger.exportedAt);
    if(ledger.version!==1||ledger.complete!==true||!Array.isArray(ledger.memory)||!Array.isArray(ledger.conversations)||
      !Number.isFinite(age)||age>15*60_000||age< -5*60_000)throw new Error("A fresh complete deletion ledger is required");
    const json=JSON.stringify(ledger);let tag:string;
    do{tag="$ledger_"+randomUUID().replaceAll("-","")+"$";}while(json.includes(tag));
    await psql(`BEGIN;
      SELECT agents_platform.replay_memory_deletion_ledger((${tag}${json}${tag}::jsonb)->'memory');
      SELECT agents_platform.replay_conversation_deletion_ledger((${tag}${json}${tag}::jsonb)->'conversations');
      COMMIT;`,service);
  }else{
    const organization=values.get("--organization"),days=values.get("--days"),operator=values.get("--operator");
    if(!organization||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(organization)||!['90','never'].includes(days??''))throw new Error("Organization UUID and --days 90 or never required");
    if(!operator||!/^[a-zA-Z0-9@_.:-]{1,128}$/.test(operator))throw new Error("Named maintenance operator required");
    await psql(`BEGIN; INSERT INTO agents_platform.conversation_retention_policies(organization_id,inactivity_days)
      VALUES('${organization}',${days==='90'?'90':'NULL'}) ON CONFLICT(organization_id)
      DO UPDATE SET inactivity_days=excluded.inactivity_days,updated_at=now();
      INSERT INTO agents_platform.conversation_retention_policy_events(id,organization_id,inactivity_days,operator)
        VALUES('${randomUUID()}','${organization}',${days==='90'?'90':'NULL'},'${operator}'); COMMIT;`,service);
  }
}
if(require.main===module)void retentionLedgerCommand(process.argv.slice(2)).then(()=>console.info("Retention command completed"))
  .catch(()=>{console.error("Retention command failed; verify the private ledger and database configuration");process.exitCode=1;});
