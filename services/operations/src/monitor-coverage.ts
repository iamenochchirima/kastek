import type {OperationsMeasurementSummary} from '@kasitek-labs/contracts';
/** Only status metadata escapes the stored snapshot; evidence, values and payloads stay private. */
export const monitorCoverageQuery=`SELECT m.*, coverage.signal_statuses FROM ops_monitors m
 LEFT JOIN LATERAL (SELECT snapshot FROM ops_observations WHERE monitor_id=m.id ORDER BY observed_at DESC,id DESC LIMIT 1) latest ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('key',signal->>'key','status',signal->>'status','coverage',signal->>'coverage','value',CASE WHEN signal->>'key'='source.read_ready' THEN signal->>'value' ELSE NULL END)) signal_statuses
 FROM (SELECT signal FROM jsonb_array_elements(COALESCE(latest.snapshot->'signals','[]'::jsonb)) signal LIMIT 100) bounded) coverage ON true
 ORDER BY m.source,m.id LIMIT 100`;
export function measurementSummary(raw:unknown):OperationsMeasurementSummary{
 const result:OperationsMeasurementSummary={total:0,available:0,unknown:0,unsupported:0,notConfigured:0,noActivity:0,readReady:'unknown'};
 if(!Array.isArray(raw))return result;
 for(const signal of raw.slice(0,100)){
  if(!signal||typeof signal!=='object')continue;
  if(signal.key==='source.read_ready'){
   if(signal.status==='available'&&signal.coverage==='complete')result.readReady=signal.value==='1'?'ready':signal.value==='0'?'unavailable':'unknown';
   continue;
  }
  if(signal.key==='source.available')continue;
  result.total++;
  if(signal.status==='available')result.available++;
  else if(signal.status==='unsupported')result.unsupported++;
  else if(signal.status==='not_configured')result.notConfigured++;
  else if(signal.status==='no_activity')result.noActivity++;
  else result.unknown++;
 }
 return result;
}
