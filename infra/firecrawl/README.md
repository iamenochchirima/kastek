# Local Firecrawl

This optional, independently operated stack provides Firecrawl's HTTP API at
`http://127.0.0.1:3002`. It has its own PostgreSQL, Redis and RabbitMQ volumes;
only the API port is published, on loopback. Browser rendering and queue workers
run continuously while the stack is up. No model credentials or AI extraction
are configured.

## Start and stop

From the repository root:

```sh
cp infra/firecrawl/.env.example infra/firecrawl/.env
# Replace both passwords with distinct values from: openssl rand -hex 24
chmod 600 infra/firecrawl/.env
docker compose -f infra/firecrawl/compose.yaml up -d
docker compose -f infra/firecrawl/compose.yaml ps
curl --fail http://127.0.0.1:3002/
```

The ignored `.env` contains local service passwords. Use hexadecimal passwords
because the RabbitMQ connection URL embeds its password. Change
`FIRECRAWL_PORT` there if port 3002 is occupied.

```sh
curl --fail http://127.0.0.1:3002/v2/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
docker compose -f infra/firecrawl/compose.yaml stats --no-stream
docker compose -f infra/firecrawl/compose.yaml logs --tail 100 api
docker compose -f infra/firecrawl/compose.yaml stop
# Remove containers/network while keeping stored data:
docker compose -f infra/firecrawl/compose.yaml down
```

`stop` is useful when no website imports are needed. `up -d` resumes the same
volumes. Do not pass `down --volumes` unless the operator intends to delete
Firecrawl's stored queues and results. This stack does not share product data.

## Resources

The initial configuration allows one concurrent crawl request/browser page and
one NUQ worker. The API needs headroom above its idle footprint: upstream
workers pause admission near their memory threshold. Aggregate container memory
ceilings are 3,456 MiB, with CPU ceilings totaling 3.75 cores. These are ceilings, not expected idle consumption.
`FIRECRAWL_MAX_RAM=0.9` controls upstream host-memory admission; the
upstream 0.8 default stalled workers on this already-busy development machine.
This does not raise the container memory ceiling. Lower the threshold or stop
the stack if the machine is under memory pressure. Redis refuses additional
writes at 96 MiB instead of evicting queued data.
Resource exhaustion should surface as a failed job, not unlimited memory growth.
Logs rotate at 10 MiB with two files per service. Watch `stats`, container restart
counts and failed jobs before increasing concurrency or hosting this stack.

## Verified local baseline

On 26 October 2026, all five services reached healthy state with these pinned
images. `/v2/scrape` returned example.com Markdown, and a queued one-page crawl
completed through the Agents adapter. The Playwright service also rendered
example.com directly (1,989 HTML characters). A loopback browser destination
returned no content. This is a focused startup and public-page smoke check,
not an exhaustive SSRF or anti-bot compatibility audit.

After that browser request, a `docker stats --no-stream` snapshot measured about
1.7 GiB RAM across the stack: API 1.27 GiB, browser 217 MiB, PostgreSQL 91 MiB,
RabbitMQ 106 MiB and Redis 6 MiB. This is one local observation, not a sizing or
hosting-price guarantee. No model calls ran. Shut down the stack when unused on
memory-constrained development machines.

## Exposure and boundaries

`USE_DB_AUTHENTICATION=false` is the upstream local mode: **this API is not an
authenticated public service**. Do not change the bind address to `0.0.0.0`,
publish backing-service ports or put it on a public Railway domain. A hosted
installation needs a private endpoint reachable only by the Agents API and a
separate access-control/egress review.

The pinned browser artifact checks destinations and browser subrequests for
private addresses and leaves `ALLOW_LOCAL_WEBHOOKS` disabled. These application checks
are not a verified network egress isolation boundary; the stack has outbound
network access and hosted blocklist behavior differs in local mode. Keep public
untrusted direct access disabled. Do not claim DNS-rebinding/redirect protection
for every scraping engine without verifying the deployed artifacts and adding
network enforcement as needed.

The Agents API exposes owner-authenticated crawl admission and review through agent creation
and Configure → General → Import website. Firecrawl itself remains loopback-only. Selected pages
enter the current private knowledge candidate pipeline; owner approval, public visibility and
agent attachment remain explicit. The separate exact-URL knowledge import flow is unchanged.
Cloud and local job IDs/results remain on their originating instance; switching
the configured endpoint affects new jobs, not queued work on another backend.

## Upstream and pinned artifacts

The Compose topology follows the official
[self-hosting guide](https://docs.firecrawl.dev/contributing/self-host) and
[v2.11.0 Compose reference](https://github.com/firecrawl/firecrawl/blob/v2.11.0/docker-compose.yaml).
The upstream API has no published `:2.11.0` image at verification time. The API,
browser and NUQ PostgreSQL images are therefore pinned to verified published
GHCR manifest digests in `compose.yaml`, rather than claiming a release-tag
match. The pinned API image records `FIRECRAWL_BUILD_SHA` as
`4c1e0d2aa15dd52ecc877630e58cf4d842701147` (26 October 2026). Redis and
RabbitMQ are also pinned. Upgrading requires an explicit digest
change and health plus `/v2/scrape` verification; never replace pins with `latest`.
FoundationDB is not enabled; the stable PostgreSQL queue backend is used.

Firecrawl is separate third-party software, licensed under
[GNU AGPL-3.0](https://github.com/firecrawl/firecrawl/blob/v2.11.0/LICENSE).
Upstream [source and image builds](https://github.com/firecrawl/firecrawl) remain
separate from KasiTek product code. Preserve applicable notices and review license
obligations before distributing modified builds or offering a hosted service.
