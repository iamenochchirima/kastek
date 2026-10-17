import type {Pool} from "pg";

export async function dropClosedTestDatabase(admin:Pool,database:string):Promise<void>{
 if(!/^agents_[a-z0-9_]+$/.test(database))throw Error("Refusing to drop a non-fixture database");
 // pg-pool may resolve end() before idle clients finish their socket-close callbacks.
 const deadline=Date.now()+5000;
 while((await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1",[database])).rowCount){
  if(Date.now()>=deadline)throw Error(`Fixture database still has open sessions: ${database}`);
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
}
