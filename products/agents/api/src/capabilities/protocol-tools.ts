import { PlatformError, requestDigest } from "../contracts/contracts";
import { historyToolDefinitions } from "./history-tools";
import { toolDiscoveryDefinitions } from "./tool-discovery";
import { toolDescriptor } from "./tool-descriptors";

export const PROTOCOL_TOOL_NAMES = ["tools.discover", "tools.load", "history.search", "history.read"] as const;
export interface PublishedToolBinding { name: string; version: string; digest: string }
const aliases = { "tools.discover": "tools_discover", "tools.load": "tools_load", "history.search": "history_search", "history.read": "history_read" } as const;

/** Missing pins identify the original implicit protocol, not permission to adopt a newer schema. */
export function protocolToolVersions(acceptedBindings?: readonly PublishedToolBinding[]): ReadonlyMap<string, string> {
  const versions = new Map(acceptedBindings?.map(binding => [binding.name, binding.version]));
  for (const name of PROTOCOL_TOOL_NAMES) if (!versions.has(name)) versions.set(name,
    acceptedBindings === undefined ? toolDescriptor(name)!.version : "1");
  return versions;
}

/** These protocol definitions are published separately and never enter the direct tool catalogue. */
export function protocolToolBindings(versions?: ReadonlyMap<string, string>): PublishedToolBinding[] {
  const definitions = [...toolDiscoveryDefinitions(versions), ...historyToolDefinitions(versions)];
  return PROTOCOL_TOOL_NAMES.map(name => {
    const version = versions === undefined ? undefined : versions.get(name) ?? "1";
    const descriptor = toolDescriptor(name, false, version), definition = definitions.find(tool => tool.function.name === aliases[name]);
    if (!descriptor || !definition) throw new PlatformError("TOOL_VERSION_UNAVAILABLE", 503, "Published protocol tool is unavailable on this worker");
    return { name, version: descriptor.version, digest: requestDigest({ descriptor, definition, outputSchema: descriptor.outputSchema }) };
  });
}
