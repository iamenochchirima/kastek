"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  deployedAt?: string | null;
};

type AgentTemplate = {
  value: string;
  label: string;
  channel: string;
  description: string;
};

const templates: AgentTemplate[] = [
  {
    value: "whatsapp_agent",
    label: "WhatsApp Agent",
    channel: "whatsapp",
    description: "Inbound customer messaging, qualification, replies, and handoff.",
  },
  {
    value: "website_agent",
    label: "Website Agent",
    channel: "website",
    description: "Website chat, lead capture, and booking or quote routing.",
  },
  {
    value: "voice_agent",
    label: "Voice Agent",
    channel: "voice",
    description: "After-hours call handling, FAQs, and routing support.",
  },
  {
    value: "support_agent",
    label: "Support Agent",
    channel: "support",
    description: "Customer service workflows across messaging and internal escalation.",
  },
  {
    value: "booking_agent",
    label: "Booking Agent",
    channel: "booking",
    description: "Appointment capture, qualification, reminders, and confirmations.",
  },
  {
    value: "lead_qualification_agent",
    label: "Lead Qualification Agent",
    channel: "lead_qualification",
    description: "Lead triage, qualification, and sales handoff workflows.",
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
      return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
    case "pending_manual":
      return "border-white/15 bg-white/5 text-muted-foreground";
    case "error":
      return "border-red-500/30 bg-red-500/10 text-red-300";
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
      return "border-red-500/30 bg-red-500/10 text-red-300";
    default:
      return "border-border bg-secondary text-muted-foreground";
  }
}

export function AgentsPageClient({ initialAgents }: { initialAgents: AgentListItem[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState(templates[0].value);
  const [greetingMessage, setGreetingMessage] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loading, setLoading] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const stats = useMemo(() => {
    const totalHits = initialAgents.reduce((sum, agent) => sum + agent.hitCount, 0);
    const totalConversations = initialAgents.reduce((sum, agent) => sum + agent.conversationCount, 0);
    const activeAgents = initialAgents.filter((agent) => agent.status === "active").length;
    const provisioningAgents = initialAgents.filter((agent) => agent.status === "provisioning").length;
    return { totalHits, totalConversations, activeAgents, provisioningAgents };
  }, [initialAgents]);

  const selectedTemplate = templates.find((item) => item.value === templateKey) ?? templates[0];

  function openCreateModal() {
    setCreateOpen(true);
    setStep(1);
    setError("");
  }

  function closeCreateModal() {
    setCreateOpen(false);
    setStep(1);
    setError("");
  }

  async function createAgent() {
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
          name,
          type: selectedTemplate.value,
          greetingMessage: greetingMessage || undefined,
          personality: instructions || undefined,
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
          },
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || "Failed to create agent");
      }

      setName("");
      setGreetingMessage("");
      setInstructions("");
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

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">KasiAgents</h1>
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
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
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
                  Start with a managed WhatsApp, website, voice, or support agent. Create the
                  control-plane record here, then provision and monitor it from KasiAgents.
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
                    {agent.deploymentError ? (
                      <p>
                        <span className="text-foreground">Deployment note:</span>{" "}
                        {agent.deploymentError}
                      </p>
                    ) : null}
                  </div>

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
          step={step}
          setStep={setStep}
          name={name}
          setName={setName}
          templateKey={templateKey}
          setTemplateKey={setTemplateKey}
          greetingMessage={greetingMessage}
          setGreetingMessage={setGreetingMessage}
          instructions={instructions}
          setInstructions={setInstructions}
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
  step,
  setStep,
  name,
  setName,
  templateKey,
  setTemplateKey,
  greetingMessage,
  setGreetingMessage,
  instructions,
  setInstructions,
  loading,
  error,
  onClose,
  onSubmit,
}: {
  step: number;
  setStep: (value: number) => void;
  name: string;
  setName: (value: string) => void;
  templateKey: string;
  setTemplateKey: (value: string) => void;
  greetingMessage: string;
  setGreetingMessage: (value: string) => void;
  instructions: string;
  setInstructions: (value: string) => void;
  loading: boolean;
  error: string;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const selectedTemplate = templates.find((item) => item.value === templateKey) ?? templates[0];
  const canContinue = step === 1 ? name.trim().length > 0 : true;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 bg-black/65"
        onClick={onClose}
        aria-label="Close create agent modal"
      />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="w-full max-w-3xl rounded-2xl border border-border bg-card shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-5">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                Create Agent
              </p>
              <h2 className="text-2xl font-semibold text-foreground">Managed agent setup</h2>
              <div className="flex flex-wrap gap-2 text-xs">
                {[1, 2, 3].map((item) => (
                  <span
                    key={item}
                    className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 ${
                      item === step
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : item < step
                          ? "border-accent/30 bg-accent/10 text-accent"
                          : "border-border bg-secondary text-muted-foreground"
                    }`}
                  >
                    {item < step ? <Check className="h-3 w-3" /> : null}
                    Step {item}
                  </span>
                ))}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-5 px-6 py-6">
            {error ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            {step === 1 ? (
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Agent Name</label>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Sales Assistant"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Template</label>
                  <select
                    value={templateKey}
                    onChange={(event) => setTemplateKey(event.target.value)}
                    className="border-input bg-background text-foreground h-8 w-full rounded-md border px-3 text-sm outline-none"
                  >
                    {templates.map((template) => (
                      <option key={template.value} value={template.value}>
                        {template.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="lg:col-span-2 rounded-xl border border-border bg-secondary/30 p-4">
                  <p className="text-sm text-muted-foreground">{selectedTemplate.description}</p>
                </div>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Greeting</label>
                  <Input
                    value={greetingMessage}
                    onChange={(event) => setGreetingMessage(event.target.value)}
                    placeholder="Hi, how can I help you today?"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Instructions</label>
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder="Qualify enquiries, collect the right details, and hand off sales-ready leads."
                    className="border-input bg-background text-foreground min-h-32 w-full rounded-md border px-3 py-2 text-sm outline-none"
                  />
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-secondary/25 p-4">
                  <div className="grid gap-3 text-sm">
                    <p>
                      <span className="text-foreground">Name:</span> {name || "Not set"}
                    </p>
                    <p>
                      <span className="text-foreground">Template:</span> {selectedTemplate.label}
                    </p>
                    <p>
                      <span className="text-foreground">Channel:</span> {selectedTemplate.channel}
                    </p>
                    <p>
                      <span className="text-foreground">Greeting:</span>{" "}
                      {greetingMessage || "No greeting set"}
                    </p>
                    <p>
                      <span className="text-foreground">Instructions:</span>{" "}
                      {instructions || "No instructions set"}
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-primary/20 bg-primary/10 p-4 text-sm text-muted-foreground">
                  This creates the managed control-plane record in KasiTek first. Provisioning into
                  the hidden n8n layer happens after the agent exists.
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-5">
            <Button variant="outline" onClick={step === 1 ? onClose : () => setStep(step - 1)}>
              {step === 1 ? "Cancel" : "Back"}
            </Button>

            {step < 3 ? (
              <Button onClick={() => setStep(step + 1)} disabled={!canContinue}>
                Continue
              </Button>
            ) : (
              <Button onClick={onSubmit} disabled={loading || !name.trim()}>
                {loading ? "Creating..." : "Create Agent"}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
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
