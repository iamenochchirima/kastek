import { describe, expect, it } from "vitest";
import { compactionDidNotProgress, compactionForecast, measureCompactionProgress } from "../src/execution/context/compaction-progress";
import type { ContextGroup } from "../src/execution/context/context";

const group = (id: string, bytes: number): ContextGroup => ({id,messages:[{role:"user",content:"x".repeat(bytes)}]});
describe("whole-context compaction progress",()=>{
  it("advances a route's compaction trigger when measured growth consumes its remaining headroom",()=>{
    const policy={maxInputTokens:10000,compactAtTokens:8000,safetyTokens:500};
    expect(compactionForecast(policy,7000,6500)).toMatchObject({triggerTokens:8000,requested:false});
    expect(compactionForecast(policy,7000,4000)).toMatchObject({growthTokens:3000,triggerTokens:6500,requested:true});
    expect(compactionForecast(policy,6000,7000)).toMatchObject({growthTokens:0,triggerTokens:8000,requested:false});
    expect(compactionForecast(policy,8100,8000,7800)).toMatchObject({mandatoryTokens:7800,triggerTokens:9400,requested:false});
  });
  it("allows productive remaining context reduction independent of packed prefix size",()=>{
    const previous=measureCompactionProgress([group("first",1000),group("second",4000),group("third",1000)]);
    const next=measureCompactionProgress([group("second",4000),group("third",1000)],{id:"summary",revision:1,kind:"summary",content:"Short confirmed summary"});
    expect(next.remainingBytes).toBeLessThan(previous.remainingBytes);
    expect(compactionDidNotProgress(previous,next)).toBe(false);
  });
  it("keeps automatic model-pressure compaction near 85% of the input allowance",()=>{
    const policy={maxInputTokens:196608,compactAtTokens:167116,safetyTokens:1024};
    expect(compactionForecast(policy,100000)).toMatchObject({requested:false});
    expect(compactionForecast(policy,167000)).toMatchObject({requested:false});
    expect(compactionForecast(policy,167200)).toMatchObject({requested:true});
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
