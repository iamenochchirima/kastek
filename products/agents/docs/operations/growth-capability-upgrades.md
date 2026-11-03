# Growth capability upgrades

Owner: Agents engineering. Reviewed: 2026-11-03.

Growth managers review capability changes independently from instructions, model, context, memory,
source and skill selections. The signed `features.upgrade.preview` and `features.upgrade.apply`
commands use the current Growth publication supplied by the product API. The browser cannot submit
its own publication. The public routes are `POST /api/agents/features/:featureId/upgrade/preview`
and `POST /api/agents/features/:featureId/upgrade/apply`.

Preview compares the prior managed capability baseline, the current feature configuration and the
installed target publication. It identifies changed operations and their effect/review contracts,
native tools, specialist relationships and affected coordinator pins. Explicit removals or customized
capabilities require a conflict choice when the proposed target differs. Keeping a direct denial
also excludes that operation from newly commissioned authority. Existing custom additions remain
existing grants; preview does not turn global catalogue membership into permission.

Apply requires the exact target-publication digest, diff digest, all observed feature revisions,
explicit conflict resolutions and a stable request ID. It locks the organization and feature/agent
rows, rechecks current manager authority through the signed Growth action endpoint, rebuilds the
same plan and publishes new immutable versions with compare-and-swap. A stale revision or changed
configuration rejects the request. Exact retries recover the committed receipt. Instructions, model,
context, memory, source/skill selections and enabled/disabled state remain unchanged. Existing
accepted tasks keep their original versions, snapshots, grants and receipts.

Dependent custom coordinators are included in the preview. An approved pin update intersects the
existing source/tool ceilings with the new child configuration and retains explicit product-operation
selection. Newly commissioned operations are disclosed in the diff. Keeping a pin leaves its old
accepted version selected. This path does not make the older automatic managed-roster refresh apply
to customized coordinators.

Fresh and fully managed defaults explicitly commission each configured specialist's product
operations. Capability-only upgrades do the same for new or unchanged managed specialist roles,
while retaining custom selections. Equivalent destination authority can share one parent binding;
every affected specialist selection is remapped to that binding. Different operation revisions,
scopes, effects or restrictions remain separate grants. The existing 64-binding limit remains.
If an approved pin would exceed it, apply returns `CAPABILITY_AUTHORITY_LIMIT` without committing.
Keep that specialist link current, or update the coordinator's own capabilities before retrying.
An approved managed pin updates that role's baseline provenance; it does not declare the whole
custom coordinator product-managed.

For an existing specialist, **Use update** adopts the reviewed product-operation selection and
pin while preserving independently customized native-tool, source and connected-tool selections,
limits, name and description. **Keep current** retains the existing specialist selection. A
referenced old commission remains available until exact-authority coalescing remaps its selection;
explicitly removing an incompatible required grant returns a conflict instead of silently restoring
it or expanding the specialist.


Schema115 adds `managed_capability_baseline` to feature mappings. This is provenance for future
three-way comparisons, not an execution grant. Existing mappings initially recover their baseline
from the exact historical version identified by `managed_configuration_digest`; a missing baseline
blocks apply. Fresh defaults and existing fully managed publication/roster changes record the new
baseline. Capability-only apply stores its canonical target baseline without overwriting the full
managed-configuration digest or declaring custom instructions product-managed.

Release: deploy schema115 before the Agents API, then matching contracts, Growth API and UI. The
new signed commands and optional `authorization.check.manage` field are additive; an older action
endpoint rejects the new field, so manager authorization cannot silently downgrade. Reuse existing
command receipts and diagnostics; new analytics events, log pipelines and hosted scheduling are
not applicable. Rollback stops new upgrade requests and restores compatible code while retaining
schema115 and immutable accepted versions. Reverse an applied assignment through a new reviewed
version, not by rewriting historical configuration or operation receipts. No hosted rollout is
claimed by local verification.
