# Railway watch paths

`watch-paths.json` records the production repository-root watch patterns for all 13 Git-backed
Railway services. Six database services deploy pinned images and have no Git source.

Watch each service's runtime source, schema/migrations, package/build configuration and actual
shared packages. API/worker pairs share one product artifact and intentionally share watch paths.
Root workspace manifests and the lockfile affect all Node backends. Shared contracts and server
support also affect all consuming Node backends. Backend Dockerfile changes affect the services
using that image; Identity, Restate and the Collector use their own build inputs.

`VERSION`, product documentation, tests, frontend source and this inventory do not trigger backend
deployments. Release metadata changes alone do not change an application image. A release that
needs an otherwise unchanged service rebuilt must explicitly deploy that service. Watch paths do
not replace migrations, dependency review or runtime verification.

These patterns are configured in each production Railway service's build settings. They are not
a Railway config file and do not apply automatically on push. When changing this inventory, update
the matching service's `watchPatterns` through Railway settings/API and read the value back. Keep
other service settings unchanged. Railway config-as-code can override dashboard settings, so any
future linked configuration must preserve the corresponding patterns.

Run `node scripts/check-railway-watch-paths.mjs` under Node 24 to check representative runtime,
shared, schema and excluded changes. The check verifies this inventory; production readback verifies
the deployed configuration. Before changing live settings, retain the previous patterns for rollback.
The 2026-11-02 rollout narrowed all 13 live services and verified six image-only sources. It retained
the old account's service-scoped approach, translated to the current monorepo paths.

References: [Railway build configuration](https://docs.railway.com/builds/build-configuration),
[config-as-code precedence](https://docs.railway.com/config-as-code/reference).
