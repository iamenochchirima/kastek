import type {ProcedureReference,ProcedureReceipt} from "./procedures";

/** Product-owned snapshot. Execution never reads customer tables to infer these facts. */
export type ProcedureDomainSnapshot={
 currentProcedures:ProcedureReference[];
 request:{id:string;status:"requested"|"human_owned"|"completed"|"withdrawn";noticeMessageId:string;inputMessageId:string;choiceMessageId:string|null;disposition:"human_only"|"withdrawn"|"self_service"|"declined"|null;noticeStatus:ProcedureReceipt["status"]|null}|null;
 customerEvidence:Array<{id:string;text:string}>;
};
