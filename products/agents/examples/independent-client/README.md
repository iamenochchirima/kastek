# Independent Agents client

A single-file client that imports nothing from the Agents source tree. It talks only to the
documented application HTTP API, authenticates with an application credential, creates a
generic agent, assigns one fixture tool binding, previews and publishes it, binds a website
deployment, starts a run, waits for it, reads pending decisions and reads one activity
snapshot.

## Workspace setup (owner, once)

1. Create an application and credential with the scopes it needs:

   ```
   POST /api/organizations/:organizationId/applications
   { "name": "Independent client", "agentIds": [], "scopes": [
     "agents:read", "agents:manage", "agents:publish", "runs:start", "runs:read" ] }
   ```

   Store the returned `credential.secret`; it is shown once.
2. Create a fixture tool. Import a small OpenAPI document, select one read operation and keep
   the resulting `bindingId`, or use a builtin tool such as `artifact.create`. The connected
   fixture can be any reachable API, including a local test server.
3. Assign the application to the agents it may manage with
   `PUT /api/organizations/:organizationId/applications/:applicationId/agents`.

## Run

```
AGENTS_URL=http://localhost:3100 \
AGENTS_APPLICATION_CREDENTIAL=kat_... \
AGENTS_FIXTURE_TOOL_BINDING=<binding uuid> \
AGENTS_AGENT_NAME="Independent client agent" \
AGENTS_MESSAGE="Use the fixture tool and report the result." \
node client.mjs
```

Optional environment variables:

| Variable | Meaning |
| --- | --- |
| `AGENTS_FIXTURE_TOOL` | Builtin tool to assign instead of a connected binding, e.g. `artifact.create` |
| `AGENTS_ALLOWED_ORIGINS` | Comma-separated deployment origins, default `https://client.example` |
| `AGENTS_CONFIGURATION_PATH` | Alternate generic configuration JSON |
| `AGENTS_DELEGATED_SUBJECT` | End-user subject to assert |
| `AGENTS_APPLICATION_ID`, `AGENTS_ORGANIZATION_ID`, `AGENTS_DELEGATED_PRIVATE_KEY` | Ed25519 key and identifiers for the delegated assertion |

The script prints a JSON transcript: created agent and version, deployment, final run output,
pending decisions, one activity snapshot and every HTTP call it made.

## What it proves

The client uses the same public contract an external product would use: application bearer
credential, scoped agent management, immutable publication, a bound fixture tool and a run
with a stable request id. It does not read the platform database or import server code. The
contract test in `products/agents/api/test/independent-client.test.ts` drives every call
against a documented-shape fixture and checks request bodies, scope-bearing headers and the
poll-to-completion path.
