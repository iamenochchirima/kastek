import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { preferredSupportContactSchema } from "../../contracts/human-assistance";

/** Reuse a verified channel participant, never an email match, as the contact identity. */
export async function projectSupportContact(db: PoolClient, requestId: string): Promise<string | null> {
  const row = (await db.query(`SELECT h.contact,c.organization_id,c.channel_kind,c.deployment_id,c.session_id,
    c.channel_deployment_id,c.external_sender_id
    FROM agents_platform.human_assistance_requests h
    JOIN agents_platform.customer_conversations c ON c.id=h.conversation_id AND c.organization_id=h.organization_id
    JOIN agents_platform.tasks t ON t.id=h.task_id AND t.organization_id=h.organization_id
      AND t.conversation_id=c.execution_conversation_id
    WHERE h.id=$1 AND h.contact IS NOT NULL AND t.evaluation_trial_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels x WHERE x.deployment_id=c.deployment_id)
      AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels x WHERE x.deployment_id=c.channel_deployment_id)
      AND ((c.channel_kind='website' AND t.principal->>'kind'='visitor'
        AND t.principal->>'deploymentId'=c.deployment_id::text AND t.principal->>'sessionId'=c.session_id::text)
      OR (c.channel_kind<>'website' AND t.principal->>'kind'='channel_customer'
        AND t.principal->>'deploymentId'=c.channel_deployment_id::text AND t.principal->>'participantId'=c.id::text))
    FOR UPDATE OF h`, [requestId])).rows[0];
  if (!row) return null;
  const parsed = preferredSupportContactSchema.safeParse(row.contact);
  if (!parsed.success) return null;
  const contact = parsed.data;
  if (!contact.name && contact.method === "same_channel") return null;
  const participant = row.channel_kind === "website"
    ? `website:${row.deployment_id}:${row.session_id}`
    : `${row.channel_kind}:${row.channel_deployment_id}:${row.external_sender_id}`;
  const phone = contact.method === "phone" && contact.value
    ? `${contact.value.startsWith("+") ? "+" : ""}${contact.value.replace(/\D/g, "")}` : null;
  const values = [randomUUID(), row.organization_id, participant, contact.name ?? null,
    contact.method === "email" ? contact.value : null, phone];
  const inserted = (await db.query(`INSERT INTO agents_platform.customer_contacts
    (id,organization_id,participant_key,name,email,phone) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(organization_id,participant_key) DO UPDATE SET
      name=coalesce(customer_contacts.name,EXCLUDED.name),
      email=coalesce(customer_contacts.email,EXCLUDED.email),
      phone=coalesce(customer_contacts.phone,EXCLUDED.phone),
      revision=customer_contacts.revision+1,updated_at=now()
    WHERE (customer_contacts.name IS NULL AND EXCLUDED.name IS NOT NULL)
       OR (customer_contacts.email IS NULL AND EXCLUDED.email IS NOT NULL)
       OR (customer_contacts.phone IS NULL AND EXCLUDED.phone IS NOT NULL)
    RETURNING id`, values)).rows[0];
  if (inserted) return inserted.id;
  return (await db.query(`SELECT id FROM agents_platform.customer_contacts
    WHERE organization_id=$1 AND participant_key=$2`, [row.organization_id, participant])).rows[0]?.id ?? null;
}
