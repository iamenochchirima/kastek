# kasitek-labs

Shared infrastructure and platform services owned outside the Growth, Agents, and Agency
products.

## Analytics

Labs owns the Analytics API, worker, schema, migrations, and service-owned build configuration in
[`services/analytics`](services/analytics/README.md). Growth-owned product publishers remain in
their product repositories; hosted deployment and database cutover are separate work.

The Analytics workspace currently includes a local `observability` crate copy so it can build
without Growth's Cargo workspace. Growth's copy remains in use by services that have not moved;
shared-crate ownership and distribution are still a separate boundary to settle.

From the repository root, check the service package with:

```sh
cargo check -p kasitek-analytics --bins
```
