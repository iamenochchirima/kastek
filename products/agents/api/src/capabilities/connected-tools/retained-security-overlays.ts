import type { AdapterManifest } from "../../contracts/capability-catalog";

/** Exact hosted executable identities reviewed against this security-only overlay.
 * They preserve the old binding contract while rejecting reflected credentials.
 * Unknown historical identities must remain unavailable.
 */
export const retainedSecurityOverlayManifests: readonly AdapterManifest[] = [
  {
    "schemaVersion": 1,
    "id": "github-native-read",
    "release": "github-public-read-v3",
    "executableDigest": "56ff880023762b5ac1f992e2eb34ec86f128825454bae66db2541352b29ee497",
    "transports": [
      "native_http"
    ],
    "protocolVersions": [],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "github-mcp-read",
    "release": "mcp-read-v4-sdk2.3.1",
    "executableDigest": "56ff880023762b5ac1f992e2eb34ec86f128825454bae66db2541352b29ee497",
    "transports": [
      "mcp_http"
    ],
    "protocolVersions": [
      "2026-07-28",
      "2025-11-25"
    ],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "stash-mcp-read",
    "release": "stash-items-read-v1",
    "executableDigest": "56ff880023762b5ac1f992e2eb34ec86f128825454bae66db2541352b29ee497",
    "transports": [
      "mcp_http"
    ],
    "protocolVersions": [
      "2026-07-28",
      "2025-11-25"
    ],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "deepwiki-mcp-read",
    "release": "public-repository-read-v1",
    "executableDigest": "56ff880023762b5ac1f992e2eb34ec86f128825454bae66db2541352b29ee497",
    "transports": [
      "mcp_http"
    ],
    "protocolVersions": [
      "2026-07-28",
      "2025-11-25"
    ],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "remote-mcp",
    "release": "remote-mcp-v1-sdk2.3.1-content1",
    "executableDigest": "048c9b4401fa0895664d7f16937f4d6ab39503313f7b24b6c00ab269217a36b8",
    "transports": [
      "mcp_http"
    ],
    "protocolVersions": [
      "2026-07-28",
      "2025-11-25"
    ],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "native-api",
    "release": "native-api-v2",
    "executableDigest": "cdeee25d111595fb69b44d3c219bd1d2e6fa9317a82559d0be806f4315493614",
    "transports": [
      "native_http"
    ],
    "protocolVersions": [],
    "boundedSchemaValidation": true
  },
  {
    "schemaVersion": 1,
    "id": "native-provider",
    "release": "1",
    "executableDigest": "7590fc5989a920caf05985be53e7d8bfad2fc60df91deb6f8081addda3470dab",
    "transports": [
      "native_http"
    ],
    "protocolVersions": [],
    "boundedSchemaValidation": true
  }
];
