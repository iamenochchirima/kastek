import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { config as loadEnv } from 'dotenv';

export async function provisionAdmin(pool: Pool, input: {adminId:string;issuer:string;subject:string;role:string;name:string;email:string;operatorId:string;reason:string;environment:string;active:boolean}) {
  if (!['viewer','support','security','operator','admin','owner','superadmin'].includes(input.role) || !input.adminId.trim() || !input.subject.trim() || !input.operatorId.trim() || input.reason.trim().length<8) throw new Error('Explicit admin, subject, role, operator and reason required');
  const issuer=new URL(input.issuer);
  if(issuer.username||issuer.password||issuer.search||issuer.hash||!['https:','http:'].includes(issuer.protocol))throw new Error('Invalid issuer');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const existing=await client.query('SELECT issuer,subject FROM operations.admin_principals WHERE admin_id=$1 FOR UPDATE',[input.adminId]);
    if(existing.rows[0] && (existing.rows[0].issuer!==input.issuer.replace(/\/$/,'')||existing.rows[0].subject!==input.subject))throw new Error('An existing admin ID cannot be reassigned to a different identity');
    await client.query(`INSERT INTO operations.admin_principals(admin_id,issuer,subject,role,name,email,active) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(admin_id) DO UPDATE SET role=excluded.role,name=excluded.name,email=excluded.email,active=excluded.active`,[input.adminId,input.issuer.replace(/\/$/,''),input.subject,input.role,input.name,input.email,input.active]);
    await client.query(`INSERT INTO ops_audit(id,environment,actor_id,action,status,resource_type,resource_id,code) VALUES($1,$2,$3,$4,'completed','admin_principal',$5,$6)`,[randomUUID(),input.environment,input.operatorId,input.active?'admin.grant':'admin.revoke',input.adminId,'explicit_identity_mapping']);
    // Reasons are retained separately from searchable operational metadata.
    await client.query(`INSERT INTO operations.principal_changes(admin_id,operator_id,reason,active,role) VALUES($1,$2,$3,$4,$5)`,[input.adminId,input.operatorId,input.reason,input.active,input.role]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
async function main() {
  loadEnv({path:process.env.KASITEK_ENV_FILE??'.env'});
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
  const args=new Map<string,string>();
  for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i]!,process.argv[i+1]??'');
  const required=(name:string)=>{const value=args.get(`--${name}`);if(!value)throw new Error(`--${name} required`);return value;};
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  try {
    await provisionAdmin(pool,{adminId:required('admin-id'),issuer:required('issuer'),subject:required('subject'),role:required('role'),name:required('name'),email:args.get('--email')??'',operatorId:required('operator-id'),reason:required('reason'),environment:process.env.ENVIRONMENT??'development',active:args.get('--active')!=='false'});
    process.stdout.write('Explicit admin grant saved; existing sessions revoke when role or active status changes.\n');
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('Admin grant failed. Check explicit identity mapping, role, database and required arguments.\n');process.exitCode=1;});
