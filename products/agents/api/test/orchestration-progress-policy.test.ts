import { describe, expect, it } from "vitest";
import { formatPartialResult } from "../src/execution/business/business";
import { buildContinuation } from "../src/execution/context/continuation";
import { repeatedOperationObservation } from "../src/execution/delegation/progress";

const read = { name: "product.read", request_digest: "same request", output: { status: "pending" }, error_code: null, state: "completed" };

describe("orchestration observations", () => {
  it("flags repeated requests only when their observations are also unchanged", () => {
    expect(repeatedOperationObservation([read, read], 3)).toBeNull();
    expect(repeatedOperationObservation([read, read, read], 3)).toEqual(expect.any(String));
    expect(repeatedOperationObservation([{ ...read, output: { status: "completed" } }, read, read], 3)).toBeNull();
    expect(repeatedOperationObservation([{ ...read, error_code: "WITHDRAWN" }, read, read], 3)).toBeNull();
    expect(repeatedOperationObservation([{ ...read, name: "product.other" }, read, read], 3)).toBeNull();
  });

  it("recognizes reordered product arguments without changing receipt identity or semantic distinctions", () => {
    const product = (arguments_:string,request_digest:string) => ({...read,name:"t_content_list",state:"failed",error_code:"TOOL_ARGUMENTS_INVALID",output:null,
      request_digest,request:{tool:"t_content_list",arguments:arguments_}});
    const attempts=[product('{"status":"","limit":20}',"first-receipt"),product('{"limit":20,"status":""}',"second-receipt"),product('{"status":"","limit":20}',"third-receipt")];
    expect(repeatedOperationObservation(attempts,3)).toEqual(expect.any(String));
    expect(attempts.map(value=>value.request_digest)).toEqual(["first-receipt","second-receipt","third-receipt"]);
    expect(repeatedOperationObservation([product('{"limit":1,"status":""}',"changed"),...attempts.slice(1)],3)).toBeNull();
    expect(repeatedOperationObservation([{...attempts[0]!,output:{items:[{id:"new"}]}},...attempts.slice(1)],3)).toBeNull();
    expect(repeatedOperationObservation([{...attempts[0]!,error_code:"WITHDRAWN"},...attempts.slice(1)],3)).toBeNull();
    const malformed=[product("{bad","receipt-a"),product("{bad","receipt-b"),product("{bad","receipt-c")];
    expect(repeatedOperationObservation(malformed,3)).toBeNull();
    expect(repeatedOperationObservation([malformed[0]!,malformed[0]!,malformed[0]!],3)).toEqual(expect.any(String));
    const businessHandle=(taskId:string)=>({...read,request:{arguments:JSON.stringify({taskId})}});
    expect(repeatedOperationObservation([businessHandle("one"),businessHandle("two"),businessHandle("three")],3)).toBeNull();
  });

  it("detects alternating operation cycles and preserves their identity across phase rotation", () => {
    const other = { ...read, name: "product.check", output: { answer: "unchanged" } };
    const cycle = repeatedOperationObservation([read,other,read,other,read,other],3);
    expect(cycle).toEqual(expect.any(String));
    expect(repeatedOperationObservation([other,read,other,read,other,read],3)).toBe(cycle);
    expect(repeatedOperationObservation([{...other,output:{answer:"new evidence"}},read,other,read,other,read],3)).toBeNull();
  });

  it("normalizes orchestration handle churn without erasing business resource or result changes", () => {
    const start = (index:number) => ({...read,name:"agents.start",request:{arguments:JSON.stringify({requests:[{bindingId:"research",brief:"Check claim"}]})},
      output:{children:[{taskId:`task-${index}`,conversationId:`conversation-${index}`,bindingId:"research",state:"accepted"}]}});
    const cancel = (index:number) => ({...read,name:"agents.cancel",request_digest:`cancel-${index}`,request:{arguments:JSON.stringify({taskId:`task-${index}`})},output:{taskId:`task-${index}`,state:"cancel_requested"}});
    expect(repeatedOperationObservation([cancel(3),start(3),cancel(2),start(2),cancel(1),start(1)],3)).toEqual(expect.any(String));
    expect(repeatedOperationObservation([{...read,output:{resourceId:"new-resource"}},read,read],3)).toBeNull();
    const result = { ...start(1),name:"agents.result",request:{arguments:JSON.stringify({taskId:"task-1"})},output:{taskId:"task-1",output:"First finding"} };
    expect(repeatedOperationObservation([{...result,output:{taskId:"task-2",output:"Revised finding"}},result,result],3)).toBeNull();
  });

  it("does not count revisions or rewritten plans as confirmed progress", () => {
    const record = { objective: "Investigate", steps: [] };
    expect(repeatedOperationObservation([1, 2, 3].map(revision => ({ ...read, name: "work.update", request_digest: `revision:${revision}`, request: { arguments: JSON.stringify({ expectedRevision: revision - 1, record }) }, output: { revision, record } })), 3)).toEqual(expect.any(String));
    expect(repeatedOperationObservation([{ ...read, name: "work.update", output: { revision: 4, record: { ...record, objective: "Verify findings" } } },
      ...[2, 3].map(revision => ({ ...read, name: "work.update", request_digest: `revision:${revision}`, request: { arguments: JSON.stringify({ expectedRevision: revision - 1, record }) }, output: { revision, record } }))], 3)).toEqual(expect.any(String));
    const changedResult={...read,output:{confirmedFinding:"New source content"}};
    expect(repeatedOperationObservation([changedResult,...[2,3].map(revision=>({...read,name:"work.update",output:{revision,record}}))],3)).toBeNull();
  });
});

describe("bounded partial results", () => {
  it("returns preserved findings and unresolved work without asserting completion", () => {
    const saved = buildContinuation({ operations: [], delegations: [], handles: [], artifacts: [],
      progress: { revision: 2, record: { objective: "Prepare launch", steps: [{ id: "draft", title: "Draft copy", state: "completed" }, { id: "review", title: "Review copy", state: "pending" }], questions: ["Which channel?"], evidenceTaskIds: [] } },
      results: [{ taskId: "bff43b91-ba48-4650-a4d8-6b8943d97ee1", output: "Draft finding" }] });
    const partial = formatPartialResult(saved);
    expect(partial).toContain("paused before completion");
    expect(partial).toContain("Draft finding");
    expect(partial).toContain("Review copy: pending");
    expect(partial).toContain("Unresolved: Which channel?");
    expect(formatPartialResult(saved, [])).not.toContain("Draft finding");
  });
});
