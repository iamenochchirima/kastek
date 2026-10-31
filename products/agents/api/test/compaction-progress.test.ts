import { describe, expect, it } from "vitest";
import { compactionDidNotProgress, measureCompactionProgress } from "../src/execution/context/compaction-progress";
import type { ContextGroup } from "../src/execution/context/context";

const group = (id: string, bytes: number): ContextGroup => ({id,messages:[{role:"user",content:"x".repeat(bytes)}]});
describe("whole-context compaction progress",()=>{
  it("allows productive remaining context reduction independent of packed prefix size",()=>{
    const previous=measureCompactionProgress([group("first",1000),group("second",4000),group("third",1000)]);
    const next=measureCompactionProgress([group("second",4000),group("third",1000)],{id:"summary",revision:1,kind:"summary",content:"Short confirmed summary"});
    expect(next.remainingBytes).toBeLessThan(previous.remainingBytes);
    expect(compactionDidNotProgress(previous,next)).toBe(false);
  });
  it("allows new corrections or source groups even when they grow the remaining context",()=>{
    const previous=measureCompactionProgress([group("retained",1000)]);
    const next=measureCompactionProgress([group("retained",1000),group("instruction:new",4000)]);
    expect(compactionDidNotProgress(previous,next)).toBe(false);
    expect(compactionDidNotProgress(undefined,next)).toBe(false);
  });
  it("pauses unchanged or expanding context when no new group was added",()=>{
    const groups=[group("retained",1000)],previous=measureCompactionProgress(groups);
    expect(compactionDidNotProgress(previous,measureCompactionProgress(groups))).toBe(true);
    expect(compactionDidNotProgress(previous,measureCompactionProgress(groups,{id:"summary",revision:1,kind:"summary",content:"Unhelpful expansion"}))).toBe(true);
  });
});
