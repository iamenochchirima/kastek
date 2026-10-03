import test from 'node:test';
import assert from 'node:assert/strict';
// Import helper before setting a provider, as bootstrap/initTelemetry does.
import {resultSpan,providerResultSpan,recordRetry,recordQueueAge,recordDependencyFailure} from '../dist/telemetry.js';
import {context,metrics,trace} from '@opentelemetry/api';
import {createRequire} from 'node:module';
const {MeterProvider,PeriodicExportingMetricReader,InMemoryMetricExporter}=createRequire(import.meta.resolve('@opentelemetry/sdk-node'))('@opentelemetry/sdk-metrics');
const {BasicTracerProvider,SimpleSpanProcessor,InMemorySpanExporter}=createRequire(import.meta.resolve('@opentelemetry/sdk-node'))('@opentelemetry/sdk-trace-base');
const {AsyncLocalStorageContextManager}=createRequire(import.meta.resolve('@opentelemetry/sdk-node'))('@opentelemetry/context-async-hooks');
test('shared telemetry preserves Rust operation fields and excludes error messages from spans',async()=>{
 const metricExporter=new InMemoryMetricExporter(),reader=new PeriodicExportingMetricReader({exporter:metricExporter,exportIntervalMillis:60000}),meterProvider=new MeterProvider({readers:[reader]});
 const spanExporter=new InMemorySpanExporter(),tracerProvider=new BasicTracerProvider({spanProcessors:[new SimpleSpanProcessor(spanExporter)]});
 const contextManager=new AsyncLocalStorageContextManager().enable();
 metrics.setGlobalMeterProvider(meterProvider);trace.setGlobalTracerProvider(tracerProvider);context.setGlobalContextManager(contextManager);
 try{
  await resultSpan('worker','fixture',async()=>1);
  await assert.rejects(()=>resultSpan('worker','fixture',async()=>{throw Error('customer-private-detail');}));
  let providerActiveSpan;
  await assert.rejects(()=>providerResultSpan('analytics-api','reporting.query',async()=>{providerActiveSpan=trace.getActiveSpan()?.spanContext().spanId;throw Error('provider-private-detail');}));
  recordRetry('worker','fixture',2);recordQueueAge('fixture',3);recordDependencyFailure('local-cache','read');
  await meterProvider.forceFlush();await tracerProvider.forceFlush();
  const metrics=metricExporter.getMetrics().flatMap(resource=>resource.scopeMetrics.flatMap(scope=>scope.metrics));
  const points=(name)=>metrics.find(metric=>metric.descriptor.name===name).dataPoints;
  const operationPoints=points('kasitek.operation.count');
  assert(operationPoints.some(point=>point.attributes['operation.kind']==='worker'&&point.attributes['operation.name']==='fixture'&&point.attributes.outcome==='success'));
  assert(operationPoints.some(point=>point.attributes['operation.kind']==='worker'&&point.attributes['operation.name']==='fixture'&&point.attributes.outcome==='error'));
  assert(points('kasitek.operation.retry.count').some(point=>point.attributes['operation.kind']==='worker'&&point.attributes['operation.name']==='fixture'));
  assert(points('kasitek.queue.age').some(point=>point.attributes['queue.name']==='fixture'));
  assert(points('kasitek.dependency.failure.count').some(point=>point.attributes['peer.service']==='analytics-api'&&point.attributes['operation.name']==='reporting.query'));
  assert(points('kasitek.dependency.failure.count').some(point=>point.attributes['peer.service']==='local-cache'&&point.attributes['operation.name']==='read'));
  const spans=spanExporter.getFinishedSpans();
  const background=spans.find(span=>span.name==='kasitek.background'&&span.attributes['operation.name']==='fixture');
  assert.equal(background.attributes['operation.kind'],'worker');
  const failed=spans.find(span=>span.name==='kasitek.background'&&span.status.code===2);
  assert.equal(failed.attributes['exception.type'],'Error');
  const provider=spans.find(span=>span.name==='kasitek.provider');
  assert.equal(providerActiveSpan,provider.spanContext().spanId);
  assert.equal(provider.attributes['peer.service'],'analytics-api');
  assert.equal(provider.attributes['kasitek.provider.operation'],'reporting.query');
  const exportedSpans=JSON.stringify(spans.map(({name,attributes,status})=>({name,attributes,status})));
  assert.ok(!exportedSpans.includes('customer-private-detail'));
  assert.ok(!exportedSpans.includes('provider-private-detail'));
 }finally{await meterProvider.shutdown();await tracerProvider.shutdown();metrics.disable();trace.disable();contextManager.disable();}
});
