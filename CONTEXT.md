# KasiTek Domain Context

## Approval domain

- **Action proposal:** One exact tool invocation the runtime intends to execute, including its
  capability, arguments, target snapshot, and stable operation identity.
- **Approval group:** The immutable set of action proposals presented for one approval barrier in
  one run. Approving a group covers only the proposals in that group, never future actions.
- **Approval decision:** The recorded human decision for an approval group, including the actor,
  decision time, scope, and plan identity that was reviewed.
- **Operation authorization:** The exact proof that one proposed operation is allowed to cross its
  side-effect boundary after group approval. It remains bound to the operation identity,
  arguments, target snapshot, policy revision, and expiry.
- **Approval grant:** A separately scoped, time-bounded permission that may satisfy future approval
  checks for a matching capability and resource pattern. It is not the same as approving a current
  approval group.
- **Execution outcome:** The durable result of an authorized operation. An execution failure is
  distinct from an approval rejection, expiry, or stale decision.
