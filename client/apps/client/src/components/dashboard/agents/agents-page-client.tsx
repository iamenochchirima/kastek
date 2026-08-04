"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Bot,
  ChartColumn,
  Check,
  Globe,
  MessageSquare,
  PhoneCall,
  Plus,
  Workflow,
  X,
  Zap,
} from "lucide-react";

export type AgentListItem = {
  id: string;
  userId: string;
  name: string;
  type: string;
  status: string;
  greetingMessage?: string | null;
  personality?: string | null;
  language: string;
  capabilities?: unknown;
  knowledgeBase?: unknown;
  integrationConfig?: {
    channel?: string;
    deploymentTarget?: string;
    templateKey?: string;
    workflowId?: string;
    launchMode?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  hitCount: number;
  conversationCount: number;
  handoffCount: number;
  failureCount: number;
  avgResponseTimeMs?: number | null;
  lastActiveAt?: string | null;
  deploymentStatus?: string | null;
  deploymentTarget?: string | null;
  workflowId?: string | null;
  deploymentVersion?: number | null;
  deploymentError?: string | null;
  deploymentPayload?: {
    deployment?: {
      ingress?: {
        path?: string;
        mode?: string;
        expects?: unknown;
        url?: string;
      };
      reply?: {
        mode?: string;
        configured?: boolean;
        missingRequirements?: string[] | null;
      };
      runtimeEvents?: string[];
      widget?: {
        kind?: string;
        notes?: string;
      };
    };
  } | null;
  deployedAt?: string | null;
};

export type WhatsappConnectionOption = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber?: string | null;
  verified: boolean;
  currentQualityRating: string;
};

type AgentTemplate = {
  value: string;
  label: string;
  channel: string;
  description: string;
  available: boolean;
};

const templates: AgentTemplate[] = [
  {
    value: "whatsapp_agent",
    label: "WhatsApp Agent",
    channel: "whatsapp",
    description: "Inbound customer messaging, qualification, replies, and handoff.",
    available: true,
  },
  {
    value: "website_agent",
    label: "Website Agent",
    channel: "website",
    description: "Website chat, lead capture, and booking or quote routing.",
    available: true,
  },
  {
    value: "instagram_agent",
    label: "Instagram Agent",
    channel: "instagram",
    description: "Respond to Instagram messages with the business context in view.",
    available: false,
  },
  {
    value: "messenger_agent",
    label: "Messenger Agent",
    channel: "messenger",
    description: "Handle Messenger enquiries and route work to the right person.",
    available: false,
  },
  {
    value: "voice_agent",
    label: "Voice Agent",
    channel: "voice",
    description: "Answer and qualify inbound calls with an agreed escalation path.",
    available: false,
  },
  {
    value: "workflow_agent",
    label: "Workflow Agent",
    channel: "workflow",
    description: "Run defined internal work across connected systems and approvals.",
    available: false,
  },
];

function typeLabel(value: string) {
  const match = templates.find((template) => template.value === value);
  if (match) return match.label;
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function channelLabel(agent: AgentListItem) {
  return agent.integrationConfig?.channel ?? agent.type.replace(/_agent$/, "").replace(/_/g, " ");
}

function deploymentLabel(agent: AgentListItem) {
  return agent.deploymentTarget ?? agent.integrationConfig?.deploymentTarget ?? "n8n";
}

function deploymentStatusClass(status?: string | null) {
  switch (status) {
    case "active":
      return "border-accent/30 bg-accent/10 text-accent";
    case "provisioning":
      return "border-primary/30 bg-primary/10 text-primary";
    case "paused":
      return "border-status-attention/30 bg-status-attention-soft text-status-attention";
    case "pending_manual":
      return "border-border bg-secondary text-muted-foreground";
    case "error":
      return "border-destructive/30 bg-status-danger-soft text-destructive";
    default:
      return "border-border bg-secondary text-muted-foreground";
  }
}

function statusClass(status: string) {
  switch (status) {
    case "active":
      return "border-accent/30 bg-accent/10 text-accent";
    case "provisioning":
      return "border-primary/30 bg-primary/10 text-primary";
    case "error":
      return "border-destructive/30 bg-status-danger-soft text-destructive";
    default:
      return "border-border bg-secondary text-muted-foreground";
  }
}

export function AgentsPageClient({
  initialAgents,
  whatsappConnections,
  initialTemplateKey,
}: {
  initialAgents: AgentListItem[];
  whatsappConnections: WhatsappConnectionOption[];
  initialTemplateKey?: string;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(() =>
    templates.some((template) => template.value === initialTemplateKey && template.available),
  );
  const [templateKey, setTemplateKey] = useState<string | null>(() => {
    const requestedTemplate = templates.find(
      (template) => template.value === initialTemplateKey && template.available,
    );
    return requestedTemplate?.value ?? null;
  });
  const [whatsappConnectionId, setWhatsappConnectionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const stats = useMemo(() => {
    const totalHits = initialAgents.reduce((sum, agent) => sum + agent.hitCount, 0);
    const totalConversations = initialAgents.reduce((sum, agent) => sum + agent.conversationCount, 0);
    const activeAgents = initialAgents.filter((agent) => agent.status === "active").length;
    const provisioningAgents = initialAgents.filter((agent) => agent.status === "provisioning").length;
    return { totalHits, totalConversations, activeAgents, provisioningAgents };
  }, [initialAgents]);

  const selectedTemplate = templates.find((item) => item.value === templateKey) ?? null;
  const requiresWhatsappConnection = selectedTemplate?.value === "whatsapp_agent";

  function openCreateModal() {
    setCreateOpen(true);
    const requestedTemplate = templates.find(
      (template) => template.value === initialTemplateKey && template.available,
    );
    setTemplateKey(requestedTemplate?.value ?? null);
    setWhatsappConnectionId("");
    setError("");
  }

  function closeCreateModal() {
    setCreateOpen(false);
    setTemplateKey(null);
    setWhatsappConnectionId("");
    setError("");
  }

  async function createAgent() {
    if (!selectedTemplate || !selectedTemplate.available) return;
    setLoading(true);
    setError("");

    try {
      const response = await fetch(apiUrl("/api/bots"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: selectedTemplate.label,
          type: selectedTemplate.value,
          autoProvision: true,
          capabilities: {
            analytics: true,
            handoff: true,
            deploymentMode: "managed",
          },
          businessDetails: {
            launchMode: "managed",
            provisioningStatus: "pending_template_connection",
          },
          integrationConfig: {
            channel: selectedTemplate.channel,
            deploymentTarget: "n8n",
            templateKey: selectedTemplate.value,
            launchMode: "managed",
            ...(requiresWhatsappConnection && whatsappConnectionId
              ? { whatsappConnectionId, permittedConnectionIds: [whatsappConnectionId] }
              : {}),
          },
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Failed to create agent");
      }

      setWhatsappConnectionId("");
      closeCreateModal();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setLoading(false);
    }
  }

  async function runAgentAction(agentId: string, action: "provision" | "pause" | "resume") {
    setActionLoadingId(`${agentId}:${action}`);
    setError("");

    try {
      const response = await fetch(apiUrl(`/api/bots/${agentId}/actions`), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `Failed to ${action} agent`);
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} agent`);
    } finally {
      setActionLoadingId(null);
    }
  }

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current));
      }, 1800);
    } catch {
      setError("Failed to copy to clipboard");
    }
  }

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Agents</h1>
            <p className="mt-1 text-muted-foreground">
              Manage your deployed agents, track usage, and control provisioning from one place.
            </p>
          </div>
          <Button className="gap-2" onClick={openCreateModal}>
            <Plus className="h-4 w-4" />
            Create Agent
          </Button>
        </div>

        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Agents" value={String(initialAgents.length)} icon={Bot} />
          <MetricCard label="Active" value={String(stats.activeAgents)} icon={Zap} />
          <MetricCard
            label="Tracked Hits"
            value={stats.totalHits.toLocaleString()}
            helper="From recorded agent events"
            icon={ChartColumn}
          />
          <MetricCard
            label="Conversations"
            value={stats.totalConversations.toLocaleString()}
            helper={`${stats.provisioningAgents} provisioning`}
            icon={MessageSquare}
          />
        </div>

        {initialAgents.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col gap-5 p-8 sm:flex-row sm:items-end sm:justify-between">
              <div className="max-w-2xl space-y-2">
                <h2 className="text-xl font-semibold text-foreground">No agents yet</h2>
                <p className="text-sm text-muted-foreground">
                  Choose a channel to create your first agent. WhatsApp and website agents are
                  available now; additional channels are being prepared.
                </p>
              </div>
              <Button className="gap-2 sm:self-start" onClick={openCreateModal}>
                <Plus className="h-4 w-4" />
                Create Your First Agent
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {initialAgents.map((agent) => (
              <Card key={agent.id}>
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/12 text-primary">
                        {channelLabel(agent).includes("voice") ? (
                          <PhoneCall className="h-5 w-5" />
                        ) : channelLabel(agent).includes("website") ? (
                          <Globe className="h-5 w-5" />
                        ) : (
                          <Workflow className="h-5 w-5" />
                        )}
                      </div>
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-foreground">{agent.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {typeLabel(agent.type)} · {channelLabel(agent)}
                        </p>
                      </div>
                    </div>
                    <Badge className={statusClass(agent.status)}>{agent.status}</Badge>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Badge className="border-border bg-secondary text-muted-foreground">
                      Channel: {channelLabel(agent)}
                    </Badge>
                    <Badge className="border-border bg-secondary text-muted-foreground">
                      Deploy: {deploymentLabel(agent)}
                    </Badge>
                    <Badge className={deploymentStatusClass(agent.deploymentStatus)}>
                      {agent.deploymentStatus ?? "ready"}
                    </Badge>
                    {agent.workflowId ? (
                      <Badge className="border-border bg-secondary text-muted-foreground">
                        Workflow linked
                      </Badge>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <MetricMini label="Hits" value={agent.hitCount.toLocaleString()} />
                    <MetricMini label="Conversations" value={agent.conversationCount.toLocaleString()} />
                    <MetricMini label="Handoffs" value={agent.handoffCount.toLocaleString()} />
                    <MetricMini label="Failures" value={agent.failureCount.toLocaleString()} />
                  </div>

                  <div className="grid gap-2 text-sm text-muted-foreground">
                    <p>
                      <span className="text-foreground">Instructions:</span>{" "}
                      {agent.personality || "No instructions saved yet."}
                    </p>
                    <p>
                      <span className="text-foreground">Greeting:</span>{" "}
                      {agent.greetingMessage || "No greeting set."}
                    </p>
                    <p>
                      <span className="text-foreground">Last activity:</span>{" "}
                      {agent.lastActiveAt
                        ? new Date(agent.lastActiveAt).toLocaleString()
                        : "No tracked events yet"}
                    </p>
                    <p>
                      <span className="text-foreground">Deployment version:</span>{" "}
                      {agent.deploymentVersion ? `v${agent.deploymentVersion}` : "Not deployed"}
                    </p>
                    {agent.deploymentPayload?.deployment?.ingress?.url ? (
                      <p>
                        <span className="text-foreground">Ingress URL:</span>{" "}
                        <span className="break-all">{agent.deploymentPayload.deployment.ingress.url}</span>
                      </p>
                    ) : agent.deploymentPayload?.deployment?.ingress?.path ? (
                      <p>
                        <span className="text-foreground">Ingress path:</span>{" "}
                        <span className="break-all">{agent.deploymentPayload.deployment.ingress.path}</span>
                      </p>
                    ) : null}
                    {agent.deploymentPayload?.deployment?.reply?.mode ? (
                      <p>
                        <span className="text-foreground">Reply mode:</span>{" "}
                        {agent.deploymentPayload.deployment.reply.mode}
                      </p>
                    ) : null}
                    {agent.deploymentPayload?.deployment?.reply?.missingRequirements?.length ? (
                      <p>
                        <span className="text-foreground">Missing setup:</span>{" "}
                        {agent.deploymentPayload.deployment.reply.missingRequirements.join(", ")}
                      </p>
                    ) : null}
                    {agent.deploymentPayload?.deployment?.runtimeEvents?.length ? (
                      <p>
                        <span className="text-foreground">Runtime events:</span>{" "}
                        {agent.deploymentPayload.deployment.runtimeEvents.join(", ")}
                      </p>
                    ) : null}
                    {agent.deploymentError ? (
                      <p>
                        <span className="text-foreground">Deployment note:</span>{" "}
                        {agent.deploymentError}
                      </p>
                    ) : null}
                  </div>

                  {agent.type === "website_agent" && agent.deploymentPayload?.deployment?.ingress?.url ? (
                    <div className="space-y-3 rounded-lg border border-border bg-secondary/40 p-4">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-foreground">Website widget webhook</p>
                        <p className="text-xs text-muted-foreground">
                          Point your website chat bridge or widget backend to this URL.
                        </p>
                      </div>
                      <div className="rounded-md border border-border bg-background/70 p-3">
                        <code className="block break-all text-xs text-foreground">
                          {agent.deploymentPayload.deployment.ingress.url}
                        </code>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="gap-2"
                          onClick={() =>
                            copyText(
                              `${agent.id}:webhook-url`,
                              agent.deploymentPayload?.deployment?.ingress?.url ?? "",
                            )
                          }
                        >
                          {copiedKey === `${agent.id}:webhook-url` ? (
                            <>
                              <Check className="h-4 w-4" />
                              Copied URL
                            </>
                          ) : (
                            "Copy URL"
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="gap-2"
                          onClick={() =>
                            copyText(
                              `${agent.id}:webhook-example`,
                              `fetch("${agent.deploymentPayload?.deployment?.ingress?.url ?? ""}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    message: "Hello",
    visitorId: "visitor-123",
    source: "website_widget",
  }),
});`,
                            )
                          }
                        >
                          {copiedKey === `${agent.id}:webhook-example` ? (
                            <>
                              <Check className="h-4 w-4" />
                              Copied example
                            </>
                          ) : (
                            "Copy Example"
                          )}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-3">
                    {!agent.deploymentStatus || agent.deploymentStatus === "error" ? (
                      <Button
                        onClick={() => runAgentAction(agent.id, "provision")}
                        disabled={actionLoadingId === `${agent.id}:provision`}
                      >
                        {actionLoadingId === `${agent.id}:provision` ? "Provisioning..." : "Provision Agent"}
                      </Button>
                    ) : null}

                    {agent.deploymentStatus === "pending_manual" ? (
                      <Button
                        onClick={() => runAgentAction(agent.id, "provision")}
                        disabled={actionLoadingId === `${agent.id}:provision`}
                        variant="outline"
                      >
                        Retry Provision
                      </Button>
                    ) : null}

                    {agent.deploymentStatus === "active" ? (
                      <Button
                        onClick={() => runAgentAction(agent.id, "pause")}
                        disabled={actionLoadingId === `${agent.id}:pause`}
                        variant="outline"
                      >
                        {actionLoadingId === `${agent.id}:pause` ? "Pausing..." : "Pause Agent"}
                      </Button>
                    ) : null}

                    {agent.deploymentStatus === "paused" ? (
                      <Button
                        onClick={() => runAgentAction(agent.id, "resume")}
                        disabled={actionLoadingId === `${agent.id}:resume`}
                        variant="outline"
                      >
                        {actionLoadingId === `${agent.id}:resume` ? "Resuming..." : "Resume Agent"}
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

      </div>

      {createOpen ? (
        <CreateAgentModal
          templateKey={templateKey}
          setTemplateKey={setTemplateKey}
          whatsappConnectionId={whatsappConnectionId}
          setWhatsappConnectionId={setWhatsappConnectionId}
          whatsappConnections={whatsappConnections}
          loading={loading}
          error={error}
          onClose={closeCreateModal}
          onSubmit={createAgent}
        />
      ) : null}
    </div>
  );
}

function CreateAgentModal({
  templateKey,
  setTemplateKey,
  whatsappConnectionId,
  setWhatsappConnectionId,
  whatsappConnections,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  templateKey: string | null;
  setTemplateKey: (value: string | null) => void;
  whatsappConnectionId: string;
  setWhatsappConnectionId: (value: string) => void;
  whatsappConnections: WhatsappConnectionOption[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const selectedTemplate = templates.find((item) => item.value === templateKey) ?? null;
  const requiresWhatsappConnection = selectedTemplate?.value === "whatsapp_agent";
  const canCreate = Boolean(
    selectedTemplate?.available &&
      (!requiresWhatsappConnection || whatsappConnectionId.length > 0),
  );

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-overlay"
        onClick={onClose}
        aria-label="Close create agent modal"
      />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-4xl rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                Create Agent
              </p>
              <h2 className="text-2xl font-semibold text-foreground">Choose an agent</h2>
              <p className="text-sm text-muted-foreground">
                Start with the channel where the work happens.
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-5 px-6 py-6">
            {error ? (
              <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => {
                const isSelected = template.value === templateKey;
                return (
                  <button
                    key={template.value}
                    type="button"
                    disabled={!template.available}
                    onClick={() => {
                      setTemplateKey(template.value);
                      setWhatsappConnectionId("");
                    }}
                    className={`min-h-36 rounded-xl border p-4 text-left transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10"
                        : template.available
                          ? "border-border bg-background hover:border-primary/50 hover:bg-secondary/45"
                          : "cursor-not-allowed border-border bg-secondary/30 opacity-60"
                    }`}
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-lg bg-secondary text-foreground">
                        <AgentTemplateIcon channel={template.channel} />
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                        template.available
                          ? "border-accent/30 bg-accent/10 text-accent"
                          : "border-border bg-secondary text-muted-foreground"
                      }`}>
                        {template.available ? "Available" : "Coming soon"}
                      </span>
                    </span>
                    <span className="mt-4 block text-sm font-semibold text-foreground">{template.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">{template.description}</span>
                  </button>
                );
              })}
            </div>

            {requiresWhatsappConnection ? (
              <div className="space-y-2 rounded-xl border border-border bg-secondary/25 p-4">
                <label className="text-sm font-medium text-foreground">WhatsApp number</label>
                <select
                  value={whatsappConnectionId}
                  onChange={(event) => setWhatsappConnectionId(event.target.value)}
                  className="border-input bg-background text-foreground h-9 w-full rounded-md border px-3 text-sm outline-none"
                >
                  <option value="">Select a connected WhatsApp number</option>
                  {whatsappConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {(connection.phoneDisplayNumber || connection.phoneNumberId) +
                        (connection.verified ? " · verified" : " · unverified")}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Your connected number is used for this agent. You can configure its behaviour after creation.
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-5">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={onSubmit} disabled={loading || !canCreate}>
              {loading ? "Creating..." : selectedTemplate ? `Create ${selectedTemplate.label}` : "Choose an agent"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentTemplateIcon({ channel }: { channel: string }) {
  if (channel === "website") return <Globe className="h-4 w-4" />;
  if (channel === "voice") return <PhoneCall className="h-4 w-4" />;
  if (channel === "workflow") return <Workflow className="h-4 w-4" />;
  return <MessageSquare className="h-4 w-4" />;
}

function MetricCard({
  label,
  value,
  icon: Icon,
  helper,
}: {
  label: string;
  value: string;
  icon: typeof Bot;
  helper?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
            {helper ? <p className="mt-1 text-sm text-muted-foreground">{helper}</p> : null}
          </div>
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-secondary/50 p-3">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold text-foreground">{value}</div>
    </div>
  );
}
