import { validContactPhone } from "../../contracts/contact-validation";
import { validateBuiltinArguments } from "../../capabilities/tool-contracts";
import { PlatformError } from "../../contracts/contracts";

/** Only validated proposals reach confirmation. Invalid input is handled by the tool operation. */
export async function confirmValidProposal<T>(name:string,raw:string,version:string|undefined,confirm:(proposal:unknown)=>Promise<T>):Promise<{valid:false}|{valid:true;result:T}> {
  let proposal:unknown;
  try { proposal=validateBuiltinArguments(name,JSON.parse(raw),version); }
  catch(error) {
    if(error instanceof SyntaxError || error instanceof PlatformError && error.code==="TOOL_ARGUMENTS_INVALID")return {valid:false};
    throw error;
  }
  if((name==="enquiry.submit"||name==="enquiry.amend") && typeof (proposal as {fields?:{phone?:unknown}}).fields?.phone==="string" && !validContactPhone((proposal as {fields:{phone:string}}).fields.phone))return {valid:false};
  return {valid:true,result:await confirm(proposal)};
}
