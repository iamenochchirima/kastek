import type { Pool } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";

export async function recordProductServiceAssertion(pool:Pool,product:"growth"|"agencies",verified:{clientId:string;jti:string;expiresAt:Date},command:unknown):Promise<void> {
  const digest=requestDigest(command);
  await pool.query("INSERT INTO agents_platform.product_service_assertions(product,client_id,jti,request_digest,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[product,verified.clientId,verified.jti,digest,verified.expiresAt]);
  const row=(await pool.query("SELECT request_digest FROM agents_platform.product_service_assertions WHERE product=$1 AND client_id=$2 AND jti=$3",[product,verified.clientId,verified.jti])).rows[0];
  if(row?.request_digest!==digest)throw new PlatformError("PRODUCT_ASSERTION_CONFLICT",409,"The service assertion was reused for different input");
}
