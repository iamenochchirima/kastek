import test from 'node:test';
import assert from 'node:assert/strict';
// Import helper before setting a provider, as bootstrap/initTelemetry does.
import {resultSpan,recordRetry,recordQueueAge,recordDependencyFailure} from '../dist/telemetry.js';
import {metrics} from '@opentelemetry/api';
import {createRequire} from 'node:module';
const {MeterProvider,PeriodicExportingMetricReader,InMemoryMetricExporter}=createRequire(import.meta.resolve('@opentelemetry/sdk-node'))('@opentelemetry/sdk-metrics');
test('shared instruments acquired after SDK start export operation, retry, queue and failure metrics',async()=>{
 const exporter=new InMemoryMetricExporter(),reader=new PeriodicExportingMetricReader({exporter,exportIntervalMillis:60000}),provider=new MeterProvider({readers:[reader]});metrics.setGlobalMeterProvider(provider);
 try{await resultSpan('worker','fixture',async()=>1);await assert.rejects(()=>resultSpan('worker','fixture',async()=>{throw Error('safe-class');}));recordRetry('worker','fixture',2);recordQueueAge('fixture',3);recordDependencyFailure('fixture','request');await provider.forceFlush();const data=JSON.stringify(exporter.getMetrics());for(const name of ['kasitek.operation.count','kasitek.operation.error.count','kasitek.operation.in_flight','kasitek.operation.duration','kasitek.operation.retry.count','kasitek.queue.age','kasitek.dependency.failure.count'])assert(data.includes(name),name);
 }finally{await provider.shutdown();metrics.disable();}
});
