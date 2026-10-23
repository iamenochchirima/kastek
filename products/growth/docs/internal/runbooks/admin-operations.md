# Growth operations

The central Operations page exposes Growth-owned webhook recovery and support grants.
It no longer proxies the retired agent installation/run/Temporal operator API.

## Recover a public webhook

1. Open Operations and inspect the failed delivery identifier and attempt count.
2. Request replay with the expected attempt count and a stable command identity.
3. Have a different authorized operator approve the command.
4. Inspect the existing delivery state after the worker retries it.

A stale attempt count or reused command with changed input must conflict. Do not edit payloads
or destination secrets while replaying a delivery.

## Investigate customer data

1. Create a support grant scoped to the required organization/resource, with a reason and expiry.
2. Use the supported admin business view under that grant.
3. Revoke the grant when the investigation ends.

Support grants do not grant shared execution control. For agent incidents, inspect the owning
Agents service using its current task/operation identifiers and current authorization.
Do not restore obsolete installation credentials, disable tenant checks, or place secrets or
customer message text in logs.
