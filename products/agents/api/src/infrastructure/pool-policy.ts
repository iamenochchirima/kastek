import {z} from "zod";
const role=z.strictObject({replicas:z.number().int().min(0).max(100),max:z.number().int().min(1).max(100)});
export const poolPolicySchema=z.strictObject({
 total:z.number().int().min(10).max(500).default(60),reserve:z.number().int().min(1).max(50).default(5),
 api:role.default({replicas:1,max:10}),worker:role.default({replicas:1,max:10}),
 dispatcher:role.default({replicas:0,max:4}),cleanup:role.default({replicas:3,max:2}),
 evaluation:role.default({replicas:1,max:2}),migration:role.default({replicas:1,max:1}),
}).superRefine((value,ctx)=>{
 const used=['api','worker','dispatcher','cleanup','evaluation','migration'].reduce((n,key)=>{const r=value[key as PoolRole];return n+r.replicas*r.max;},value.reserve);
 if(used>value.total)ctx.addIssue({code:'custom',message:'Declared replica pools exceed the total database connection budget'});
});
export type PoolRole='api'|'worker'|'dispatcher'|'cleanup'|'evaluation'|'migration';
export function poolPolicyFromEnvironment(environment:NodeJS.ProcessEnv=process.env){
 let value:unknown={};if(environment.AGENTS_DATABASE_POOL_POLICY_JSON){try{value=JSON.parse(environment.AGENTS_DATABASE_POOL_POLICY_JSON);}catch{throw Error('Invalid database pool policy');}}
 return poolPolicySchema.parse(value);
}
export function databasePoolOptions(role:PoolRole,environment:NodeJS.ProcessEnv=process.env){
 const policy=poolPolicyFromEnvironment(environment);if(policy[role].replicas<1)throw Error(`Database role ${role} has no declared replicas`);
 return {max:policy[role].max,application_name:`agents-${role}`,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:20000,idleTimeoutMillis:30000};
}
