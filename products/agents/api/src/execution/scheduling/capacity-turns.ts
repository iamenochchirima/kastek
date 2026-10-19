import type {PoolClient} from "pg";

export interface CapacityCandidate {id:string;task_id:string;organization_id:string;promote:boolean}

/** Assign a durable tenant/class/account turn; assignment alone is not execution progress. */
export async function selectCapacityCandidates(db:PoolClient,limit:number):Promise<CapacityCandidate[]> {
 const tenants=(await db.query(`SELECT st.organization_id FROM agents_platform.scheduling_tenants st WHERE EXISTS(
  SELECT 1 FROM agents_platform.capacity_requests q WHERE q.organization_id=st.organization_id
  AND (q.state='waiting' OR q.state='granted' AND q.lease_until<=now()))
  ORDER BY st.last_capacity_at,st.organization_id FOR UPDATE OF st SKIP LOCKED LIMIT $1`,[limit])).rows;
 if(!tenants.length)return [];
 const ids=tenants.map(row=>row.organization_id);
 await db.query('UPDATE agents_platform.scheduling_tenants SET last_capacity_at=now() WHERE organization_id=ANY($1::uuid[])',[ids]);
 return (await db.query<CapacityCandidate>(`WITH due AS MATERIALIZED (
  SELECT q.*,q.created_at+CASE WHEN q.workload='interactive' THEN interval '0 seconds' ELSE interval '5 seconds' END AS priority_at
  FROM agents_platform.capacity_requests q WHERE q.organization_id=ANY($1::uuid[])
  AND (q.state='waiting' OR q.state='granted' AND q.lease_until<=now())),
  unavailable AS MATERIALIZED (SELECT b.key FROM (SELECT DISTINCT unnest(bucket_keys) AS key FROM due) relevant
   JOIN agents_platform.capacity_buckets b ON b.key=relevant.key
   WHERE NOT EXISTS(SELECT 1 FROM agents_platform.capacity_slots s WHERE s.bucket_key=b.key AND s.owner_request IS NULL)
   AND NOT EXISTS(SELECT 1 FROM agents_platform.capacity_slot_ranges r WHERE r.bucket_key=b.key AND r.next_slot<=b.max_active)),
  chosen AS MATERIALIZED (
   SELECT st.organization_id,turn.resource_class,turn.resource_key FROM agents_platform.scheduling_tenants st
   CROSS JOIN LATERAL (
    SELECT classes.resource_class,account.resource_key FROM (VALUES
     (0,st.capacity_model_cursor),(1,st.capacity_connected_cursor),(2,st.capacity_local_cursor),(3,NULL::text)
    ) classes(resource_class,cursor)
    CROSS JOIN LATERAL (
     SELECT resource_key FROM (
      (SELECT q.resource_key,0 AS segment FROM agents_platform.capacity_requests q
       WHERE q.organization_id=st.organization_id AND q.state='waiting' AND q.resource_class=classes.resource_class
       AND q.resource_key>coalesce(classes.cursor,'') AND q.deadline_at>now()
       AND NOT EXISTS(SELECT 1 FROM unavailable b WHERE b.key=ANY(q.bucket_keys)) ORDER BY q.resource_key LIMIT 1)
      UNION ALL
      (SELECT q.resource_key,1 AS segment FROM agents_platform.capacity_requests q
       WHERE q.organization_id=st.organization_id AND q.state='waiting' AND q.resource_class=classes.resource_class
       AND q.resource_key<=classes.cursor AND q.deadline_at>now()
       AND NOT EXISTS(SELECT 1 FROM unavailable b WHERE b.key=ANY(q.bucket_keys)) ORDER BY q.resource_key LIMIT 1)
     ) accounts ORDER BY segment LIMIT 1
    ) account ORDER BY (classes.resource_class-st.capacity_class_cursor+4)%4 LIMIT 1
   ) turn WHERE st.organization_id=ANY($1::uuid[])
  ), turns AS (
   UPDATE agents_platform.scheduling_tenants st SET capacity_class_cursor=(c.resource_class+1)%4,
    capacity_model_cursor=CASE WHEN c.resource_class=0 THEN c.resource_key ELSE st.capacity_model_cursor END,
    capacity_connected_cursor=CASE WHEN c.resource_class=1 THEN c.resource_key ELSE st.capacity_connected_cursor END,
    capacity_local_cursor=CASE WHEN c.resource_class=2 THEN c.resource_key ELSE st.capacity_local_cursor END
   FROM chosen c WHERE st.organization_id=c.organization_id RETURNING st.organization_id,c.resource_class,c.resource_key
  ), housekeeping AS (
   SELECT id,task_id,organization_id,priority_at,false AS promote,
    row_number() OVER(PARTITION BY organization_id ORDER BY priority_at,id) AS rank FROM due ORDER BY rank,priority_at,id LIMIT $2
  ), promotions AS (
   SELECT q.id,q.task_id,q.organization_id,
    q.created_at+CASE WHEN q.workload='interactive' THEN interval '0 seconds' ELSE interval '5 seconds' END AS priority_at,true AS promote,
    row_number() OVER(PARTITION BY q.organization_id ORDER BY q.created_at+CASE WHEN q.workload='interactive' THEN interval '0 seconds' ELSE interval '5 seconds' END,q.id) AS rank
   FROM agents_platform.capacity_requests q JOIN turns t ON t.organization_id=q.organization_id AND t.resource_class=q.resource_class AND t.resource_key=q.resource_key
   WHERE q.state='waiting' AND q.deadline_at>now() AND NOT EXISTS(SELECT 1 FROM unavailable b WHERE b.key=ANY(q.bucket_keys))
   ORDER BY rank,priority_at,id LIMIT $2
  ), selected AS (
   SELECT id,task_id,organization_id,priority_at,min(rank) AS rank,bool_or(promote) AS promote
   FROM (SELECT * FROM housekeeping UNION ALL SELECT * FROM promotions) lanes GROUP BY id,task_id,organization_id,priority_at
  ) SELECT id,task_id,organization_id,promote FROM selected ORDER BY rank,priority_at,id`,[ids,limit])).rows;
}
