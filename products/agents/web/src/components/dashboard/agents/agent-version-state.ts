export type AgentVersionChoice = {
  id: string;
  version_number: number;
  status: string;
};

export type AgentVersionDeployments = {
  playground?: { version?: { versionId?: string | null } | null } | null;
  live?: { version?: { versionId?: string | null } | null } | null;
};

export function agentVersionOptionLabel(version: AgentVersionChoice, status: AgentVersionDeployments | null): string {
  const states: string[] = [];
  if (status?.playground?.version?.versionId === version.id) states.push("Test");
  if (status?.live?.version?.versionId === version.id) states.push("Live");
  if (!states.length) states.push(version.status === "draft" ? "Draft" : "Saved");
  return `v${version.version_number} · ${states.join(" · ")}`;
}
