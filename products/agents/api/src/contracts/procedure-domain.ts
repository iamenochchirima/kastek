import type {PreferredSupportContact} from "./support-contact";
import type {ProcedureReference,ProcedureReceipt} from "./procedures";

/** Product-owned snapshot. Execution never reads customer tables to infer these facts. */
export type ProcedureDomainSnapshot={
 currentProcedures:ProcedureReference[];
 request:{contact?:PreferredSupportContact|null;id:string;status:"requested"|"human_owned"|"completed"|"withdrawn";noticeMessageId:string|null;replyMessageId:string|null;replyStatus:ProcedureReceipt["status"]|null;inputMessageId:string;choiceMessageId:string|null;disposition:"human_only"|"withdrawn"|"self_service"|"declined"|null;noticeStatus:ProcedureReceipt["status"]|null}|null;
 customerEvidence:Array<{id:string;text:string}>;
};
