import { randomUUID } from "node:crypto";
import { z } from "zod";

export const agentEventEnvelopeSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().uuid(),
  source: z.string().min(1),
  type: z.string().min(1),
  subject: z.string().min(1),
  time: z.string().datetime(),
  datacontenttype: z.literal("application/json"),
  data: z.record(z.string(), z.unknown()),
});

export type AgentEventEnvelope = z.infer<typeof agentEventEnvelopeSchema>;

export function createAgentEvent(input: {
  type: string;
  subject: string;
  data?: Record<string, unknown>;
  source?: string;
}): AgentEventEnvelope {
  return agentEventEnvelopeSchema.parse({
    specversion: "1.0",
    id: randomUUID(),
    source: input.source ?? "kasitek://agents",
    type: input.type,
    subject: input.subject,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data: input.data ?? {},
  });
}
