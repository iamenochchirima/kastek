import type {OperationRecord} from '../../contracts/execution';

function transientReceiptFailure(error:unknown):boolean {
 if(!error||typeof error!=='object')return false;
 const candidate=error as {code?:unknown;message?:unknown},code=typeof candidate.code==='string'?candidate.code:'';
 if(['40001','40P01','57P01','57P02','57P03'].includes(code)||/^08[0-9A-Z]{3}$/.test(code))return true;
 return candidate instanceof Error&&/^(timeout exceeded when trying to connect|Connection terminated unexpectedly|Connection terminated due to connection timeout|Query read timeout)$/.test(candidate.message);
}

/** Retain a known provider outcome while retrying only its idempotent native receipt write. */
export async function persistOperationReceipt(write:()=>Promise<OperationRecord>):Promise<OperationRecord>{
 for(let attempt=0;;attempt++){
  try{return await write();}
  catch(error){if(attempt>=2||!transientReceiptFailure(error))throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}
 }
}
