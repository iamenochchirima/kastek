import { expect,it } from "vitest";
import { metrics } from "@opentelemetry/sdk-node";
import { dispatcherPhases,type DispatcherPhase } from "../src/contracts/execution";
import { createDispatcherPhaseMetrics } from "../src/observability/metrics";

it("collects phase duration and errors with a finite metadata vocabulary",async()=>{
  const exporter=new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE);
  const reader=new metrics.PeriodicExportingMetricReader({exporter,exportIntervalMillis:60000});
  const provider=new metrics.MeterProvider({readers:[reader]});
  const record=createDispatcherPhaseMetrics(provider.getMeter("dispatcher-test"));
  try{
    for(const phase of dispatcherPhases){record(phase,12,true);record(phase,28,false);}
    for(const value of [NaN,Infinity,-1])record("dispatch",value,true);
    record("PRIVATE_TASK_ID" as DispatcherPhase,12,true);
    record("dispatch",12,"PRIVATE_PROVIDER_SECRET" as unknown as boolean);
    const {resourceMetrics}=await reader.collect();
    const data=resourceMetrics.scopeMetrics.flatMap(scope=>scope.metrics);
    const durations=data.find(metric=>metric.descriptor.name==="agents.dispatcher.phase.duration_ms")!;
    const counts=data.find(metric=>metric.descriptor.name==="agents.dispatcher.phase.passes")!;
    expect(durations.dataPoints).toHaveLength(10);
    expect(counts.dataPoints).toHaveLength(10);
    for(const point of durations.dataPoints){
      expect(point.value).toMatchObject({count:1,sum:point.attributes.outcome==="ok"?12:28});
      expect(Object.keys(point.attributes).sort()).toEqual(["outcome","phase"]);
    }
    for(const point of counts.dataPoints)expect(point.value).toBe(1);
    expect(new Set(counts.dataPoints.map(point=>point.attributes.phase))).toEqual(new Set(dispatcherPhases));
    expect(JSON.stringify(data)).not.toContain("PRIVATE_");
  }finally{await provider.shutdown();}
});
