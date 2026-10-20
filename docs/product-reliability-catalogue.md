# KasitekLabs product reliability catalogue

Status: proposed test profiles. Last updated: 2026-10-20.

These numbers are starting targets for test design, not verified capacity claims or production
commitments. Each product must agree its workload, service configuration, deadlines and test
budget before qualification. Features that are unavailable become future acceptance cases.

## User tiers

Users means simultaneously active users of the specified product, rather than registered accounts.
Record idle sessions, HTTP request rates, open connections, queued jobs and executing operations
separately. One active user can generate several requests, and one request can start background work.

| Product | 1k-user profile | 10k-user profile |
| --- | --- | --- |
| Agents | 1,000 concurrent customer conversations across 100 workspaces, plus 10 support operators | 10,000 conversations across 1,000 workspaces, plus 100 operators |
| Growth | 1,000 active marketers across 100 organizations | 10,000 marketers across 1,000 organizations |
| Agencies | 1,000 active staff/client-portal users across 100 agencies | 10,000 users across 1,000 agencies |

## Product coverage

Each row is a separate scenario. A combined workload needs an explicit mix rather than running
every maximum simultaneously. Requests per second means incoming dynamic API requests. Measure
retries, polling, rejected requests and background operations separately.

Latency targets below are proposals for the stated operations. Record p50, p95 and p99; average
latency alone cannot establish a pass. Define any unspecified deadline before running the test.

| Product | What to test | 1k-user tier | 10k-user tier | Required result |
| --- | --- | --- | --- | --- |
| Agents | Customer chat and live connections | 1,000 open connections; 20 incoming messages/sec | 10,000 connections; 200 messages/sec | Correct conversation routing and ordering; no lost accepted messages; no cross-customer leakage |
| Agents | Staff management and Inbox API | 100 requests/sec | 1,000 requests/sec | Ordinary reads p95 ≤500 ms; short mutations p95 ≤1 sec |
| Agents | FAQ knowledge retrieval | 100,000 passages; 50 searches/sec | 1 million passages; 500 searches/sec | Retrieval p95 ≤500 ms; only currently authorized sources returned |
| Agents | Context, memory and compaction | 100 conversations ×50 turns | 1,000 conversations ×50 turns | No private-memory leakage; compaction preserves required context; withdrawn knowledge stops influencing new answers |
| Agents | Human takeover and return | 5 ownership changes/sec, including 20 deliberate races | 50 changes/sec, including 200 races | Zero stale automated replies or unauthorized effects after takeover; duplicate human replies produce one delivery |
| Agents | Agent execution and delegation | 100 simultaneous runs, including 20 delegated runs | 1,000 simultaneous runs, including 200 delegated runs | Budgets enforced; child authority remains restricted; cancellation and recovery preserve original identities |
| Agents | Answer-quality regression | 100 fixed FAQ/support cases under load | Same 100 cases under load | No fabricated confirmations or unsupported citations; agreed answer/escalation rubric passes |
| Growth | Dashboard, contacts and campaign editing | 300 API requests/sec against 1 million records | 3,000 requests/sec against 10 million records | Read/write latency targets hold; pagination remains bounded; conflicting edits are handled correctly |
| Growth | Scheduled campaign execution | 1,000 actions due within one minute | 10,000 actions due within one minute | Each starts within the declared scheduling window; no duplicate execution |
| Growth | Publishing/delivery pipeline | 20 deliveries/sec to controlled receivers | 200 deliveries/sec | Exact destination/content; approval enforced; lost acknowledgements do not cause repeated logical delivery |
| Growth | Research/content agents | 50 simultaneous tasks, including 10 with specialists | 500 tasks, including 100 with specialists | Evidence retained; restricted tools respected; outputs saved to the correct organization and campaign |
| Growth | Provider webhooks | 100 events/sec, with 20% duplicates and shuffled order | 1,000 events/sec, with the same duplication/reordering | Correct final campaign state; duplicates do not repeat business actions |
| Agencies | Workspace, project and client records | 150 API requests/sec against 100,000 records | 1,500 requests/sec against 1 million records | Latency targets hold; staff and client permissions remain correct |
| Agencies | Client isolation and delegated permissions | 200 cross-client/revoked-access attempts during ordinary traffic | 2,000 attempts | Zero unauthorized access; revocation applies to subsequent operations |
| Agencies | Uploads, documents and deliverables | 20 simultaneous 10 MB uploads | 200 simultaneous 10 MB uploads | Correct checksums, ownership and access; interrupted uploads leave no falsely completed deliverables |
| Agencies | Reports and approval workflows | 2 new reports/sec; separately test 100 waiting approvals | 20 reports/sec; separately test 1,000 waiting approvals | Controlled reports complete within their deadline; waiting approvals consume no execution slot; approved delivery happens once |

For agent scenarios, report accepted tasks, actively executing operations, tasks awaiting external
responses and queued tasks separately. A backlog does not prove active execution. Record the root
count and child count separately when specialists are involved.

## Failure and recovery overlays

Apply relevant overlays to each product's ordinary workload. Specify the observation period and
recovery deadline before the run. Zero correctness violations means zero observed violations
during the declared test; it is not a universal guarantee.

| Failure overlay | Concrete starting test | Evidence |
| --- | --- | --- |
| Replica failure | Kill one API replica and one worker during traffic | Account for every accepted command; recover original identities and effects |
| External dependency failure | Inject 10% timeouts, 10% HTTP 429 responses and lost acknowledgements for 5 minutes | Bounded retries, explicit uncertainty, no repeated logical effects and recovery after restoration |
| Noisy tenant | One tenant generates 80% of traffic | Other tenants retain their declared service levels; quotas isolate the aggressive tenant |
| Reconnect storm | Disconnect 25% of live clients and reconnect them within 30 seconds | Authorized reconnect, correct ordering and bounded buffering |
| Duplicate submissions | Submit each selected command 10 times concurrently | One logical result and one intended business effect |
| Overload and recovery | Apply 3× the tier's normal arrival rate for 2 minutes, then return to normal | Explicit rejection, bounded queues and recovery within the declared window |
| Soak | Run the representative workload for 4 hours | Stable memory, connections, file handles, temporary files and queue age; successful cleanup |
| Restore | Restore into a clean environment and execute the product's core journeys | Measured recovery time, recoverable data freshness and usable business state |

## Production-like execution

Run qualification against an isolated cloud deployment using real application services and
separate load generators. The developer's computer can control the run and display results.
Record the application replicas, resource limits, database tier, regions, connection budgets,
deployment artifact and data volume. Results apply to that measured configuration.

Use real authentication, ingress, databases, durable execution, queues and object storage where
the product depends on them. Use controlled external providers for repeatable load and failure
injection. Run smaller, separate integration tests against real providers within their permitted
quotas. A controlled-provider benchmark establishes platform behavior, not live-provider capacity.

Use arrival-rate tests to sustain intended demand when the service slows, and session tests to
exercise navigation and reconnects. Keep a small real-browser cohort running during API load.
Measure the generators' CPU, network and missed starts so generator saturation is distinguishable
from application saturation.

## Test cadence

| When | Coverage |
| --- | --- |
| Every change | Relevant correctness, authorization, race/idempotency and integration tests |
| Nightly | Short cloud-staging journeys and moderate representative traffic |
| Major release or critical architecture change | Current capacity tier, deployment/rollback and selected failure-recovery cases |
| Monthly or before launch | Longer soak, backup restoration and operator recovery exercise |
| Before promising a larger tier | Planned 1k →10k →higher capacity campaign, with fixed duration and budget |
| Continuously in production | Bounded synthetic journeys, real-user measurements, service objectives and actionable alerts |

## Result record

Retain the following for each run:

- Product, scenario, code/build identity and workload revision.
- Deployment topology, resource limits, dependency mode and dataset size/distribution.
- Intended and achieved arrival rates, active users, open connections and job counts.
- Correct completions, rejections, errors, timeouts, retries and generator misses.
- Latency percentiles, queue age, saturation, recovery time and cost.
- Authoritative business-state, effect and usage checks.
- Pass/fail/inconclusive decision for each declared criterion and any untested behavior.
- Cleanup receipts for test-owned accounts, data, files and services.

A capacity statement should name the product, build, topology and measured workload. For example:

> Growth sustained 3,000 requests/sec and 200 controlled deliveries/sec on configuration X while
> meeting the declared correctness and latency criteria.

## References

- [Grafana k6: open and closed workload models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
- [AWS Well-Architected: load test your workload](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_adapt_to_changes_load_tested_adapt.html)
- [Google SRE: monitoring distributed systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [Google Cloud: test recovery from data loss](https://docs.cloud.google.com/architecture/framework/reliability/perform-testing-for-recovery-from-data-loss)
