import type { PoolClient } from "pg";
import { z } from "zod";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";
import { canonicalJson, PlatformError } from "../../contracts/contracts";
import { connectorConfiguration, connectorExecutionDigest, type NativeConnectorConfiguration } from "../../adapters/providers/connector-registry";
import { createNativeProviderCatalog } from "./native-provider-tools";

const denied = () => new PlatformError("CUSTOMER_NATIVE_AUTHORITY_DENIED", 403, "Contact intake is unavailable");
export const customerContactIntakeSchema = z.strictObject({
  email: z.email().max(254),
  firstName: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  lastName: z.string().trim().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
});

/** An email supplied in chat authorizes reviewed intake only, never customer-record lookup. */
export async function assertCustomerNativeBindings(db: PoolClient, organizationId: string, bindingIds: readonly string[]): Promise<{ binding: CapabilityBinding; ownerAccountId: string }[]> {
  z.uuid().parse(organizationId);
  z.array(z.uuid()).max(32).refine(ids => new Set(ids).size === ids.length).parse(bindingIds);
  const result: { binding: CapabilityBinding; ownerAccountId: string }[] = [];
  for (const id of bindingIds) {
    const row = (await db.query(`SELECT b.binding,c.id AS current_connection_id,c.account_id,c.organization_id,c.profile_id,c.policy_revision,c.resource_handles,
      c.state,c.expires_at,p.provider_id,p.account_subject,p.account_email,p.status AS provider_status,p.sharing,
      p.selected_operations,p.binding_ids,p.granted_scopes
      FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
      JOIN agents_platform.native_provider_connections p ON p.connection_id=c.id AND p.organization_id=c.organization_id
      JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=c.account_id AND m.role='owner' AND m.revoked_at IS NULL
      WHERE b.id=$1 AND b.organization_id=$2 AND c.organization_id=$2
      FOR SHARE OF b,c,p,m`, [id, organizationId])).rows[0];
    if (!row) throw denied();
    const parsed = capabilityBindingSchema.safeParse(row.binding);
    if (!parsed.success) throw denied();
    const binding = parsed.data, managed = binding.definition.managed;
    if (binding.id !== id || binding.organizationId !== organizationId || row.organization_id !== organizationId
      || !binding.connection || binding.connection.profileId !== "hubspot-contacts-v1" || row.profile_id !== "hubspot-contacts-v1"
      || binding.connection.id !== row.current_connection_id || binding.connection.policyRevision !== row.policy_revision || binding.definition.providerOperation !== "contacts.create"
      || binding.policy.effect !== "reviewed_write" || binding.policy.approval !== "exact_single_use"
      || binding.policy.disclosure !== "exact_reviewed_payload" || binding.policy.retry !== "status_only" || binding.policy.cancel !== "reconcile_claimed"
      || binding.transport !== "native_http" || !managed || managed.providerId !== row.provider_id
      || row.state !== "active" || new Date(row.expires_at).getTime() <= Date.now() || row.provider_status !== "ready"
      || row.sharing !== "organization_service" || !row.account_subject || !row.account_email
      || !row.selected_operations?.includes("contacts.create") || !row.binding_ids?.includes(id)
      || binding.resources.length !== 1 || binding.resources[0]?.kind !== "provider.account" || binding.resources[0].id !== row.account_subject
      || !row.resource_handles?.some((resource: { kind: string; id: string }) => resource.kind === "provider.account" && resource.id === row.account_subject)) throw denied();
    const definition = connectorConfiguration(managed.providerId) as NativeConnectorConfiguration;
    if (definition.profileId !== "hubspot-contacts-v1" || definition.adapterKey !== "hubspot-contacts-v1"
      || managed.connectorDigest !== connectorExecutionDigest(definition)) throw denied();
    const operation = definition.operations.find(operation => operation.id === "contacts.create");
    if (!operation || ![...definition.auth.scopes, ...operation.scopes].every(scope => row.granted_scopes?.includes(scope))) throw denied();
    const catalog = createNativeProviderCatalog(definition, { id: binding.catalog.id, organizationId, connectionId: binding.connection.id, revision: binding.catalog.revision });
    if (catalog.digest !== binding.catalog.digest || canonicalJson(catalog.adapter) !== canonicalJson(binding.adapter)
      || canonicalJson(catalog.tools.find(tool => tool.providerOperation === "contacts.create")) !== canonicalJson(binding.definition)) throw denied();
    result.push({ binding, ownerAccountId: row.account_id });
  }
  return result;
}
