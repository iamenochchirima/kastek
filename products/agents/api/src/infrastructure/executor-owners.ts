import type { Pool } from "pg";
import { PlatformError } from "../contracts/contracts";
import type { ExecutorOwner } from "../contracts/executor";
import { transaction } from "./database";
export class ExecutorOwners {
  constructor(readonly pool: Pool) {}
  async get(kind: ExecutorOwner["resource_kind"], id: string): Promise<ExecutorOwner | undefined> {
    return (await this.pool.query<ExecutorOwner>("SELECT * FROM agents_platform.resource_executor_owners WHERE resource_kind=$1 AND allocation_id=$2", [kind, id])).rows[0];
  }
  async claim(kind: ExecutorOwner["resource_kind"], id: string, executor: string, digest: string, deadline: Date): Promise<ExecutorOwner> {
    await this.pool.query(`INSERT INTO agents_platform.resource_executor_owners(resource_kind,allocation_id,executor_id,request_digest,lease_expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [kind, id, executor, digest, deadline]);
    const row = (await this.get(kind, id))!;
    if (row.request_digest !== digest) throw new PlatformError("EXECUTOR_IDENTITY_CONFLICT", 409, "Resource request identity conflict"); return row;
  }
  async assert(kind: ExecutorOwner["resource_kind"], id: string, executor: string, generation: string, starting: boolean): Promise<ExecutorOwner> {
    const row = await this.get(kind, id);
    if (!row || row.executor_id !== executor || row.generation !== generation) throw new PlatformError("EXECUTOR_GENERATION_STALE", 409, "Executor ownership changed");
    if (starting && (row.quiescent || new Date(row.lease_expires_at).getTime() <= Date.now())) throw new PlatformError("EXECUTOR_LEASE_EXPIRED", 409, "Resource start authority expired");
    return row;
  }
  async markQuiescent(row: ExecutorOwner, receipt: string): Promise<void> {
    const result = await this.pool.query("UPDATE agents_platform.resource_executor_owners SET quiescent=true,quiescence_receipt=$5,updated_at=now() WHERE resource_kind=$1 AND allocation_id=$2 AND executor_id=$3 AND generation=$4", [row.resource_kind, row.allocation_id, row.executor_id, row.generation, receipt]);
    if (!result.rowCount) throw new PlatformError("EXECUTOR_GENERATION_STALE", 409, "Executor ownership changed");
  }
  async claimStart(row: ExecutorOwner, maximum: number): Promise<void> {
    await transaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`executor-capacity:${row.executor_id}`]);
      const current=(await db.query("SELECT * FROM agents_platform.resource_executor_owners WHERE resource_kind=$1 AND allocation_id=$2 FOR UPDATE",[row.resource_kind,row.allocation_id])).rows[0];
      if(!current||current.executor_id!==row.executor_id||current.generation!==row.generation||current.quiescent||new Date(current.lease_expires_at).getTime()<=Date.now())throw new PlatformError("EXECUTOR_GENERATION_STALE",409,"Executor start ownership changed");
      if(current.started_at)return;
      const active=Number((await db.query("SELECT count(*) FROM agents_platform.resource_executor_owners WHERE executor_id=$1 AND started_at IS NOT NULL AND NOT quiescent",[row.executor_id])).rows[0].count);
      if(active>=maximum)throw new PlatformError("EXECUTOR_CAPACITY_BUSY",429,"Physical executor capacity is busy");
      await db.query("UPDATE agents_platform.resource_executor_owners SET started_at=now() WHERE resource_kind=$1 AND allocation_id=$2",[row.resource_kind,row.allocation_id]);
    });
  }
  async transfer(row: ExecutorOwner, destination: string, receipt: string): Promise<ExecutorOwner> {
    const result = (await this.pool.query<ExecutorOwner>(`UPDATE agents_platform.resource_executor_owners SET executor_id=$5,generation=generation+1,updated_at=now()
      WHERE resource_kind=$1 AND allocation_id=$2 AND executor_id=$3 AND generation=$4 AND quiescent AND quiescence_receipt=$6 RETURNING *`, [row.resource_kind, row.allocation_id, row.executor_id, row.generation, destination, receipt])).rows[0];
    if (!result) throw new PlatformError("EXECUTOR_TRANSFER_DENIED", 409, "Resource is not confirmed quiescent"); return result;
  }
}
