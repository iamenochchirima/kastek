import { randomUUID } from "node:crypto";
import type { ProductCapabilityManifest } from "@kasitek-labs/contracts";
import { growthAgentProductReferences } from "@kasitek-labs/contracts";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";
import { agentConfigurationSchema, PlatformError, requestDigest, type AgentConfiguration } from "../../contracts/contracts";

export interface BindingPlanVersion { id: string; organizationId: string; product: string; tenantId: string; configuration: unknown }
export interface BindingPlanClone { sourceVersionId: string; versionId: string; configuration: AgentConfiguration }
const denied = () => new PlatformError("GROWTH_RUNTIME_UPGRADE_UNAVAILABLE", 409, "The existing agent configuration cannot be upgraded safely");
const referenceSensitiveOperations = new Set(Object.keys(growthAgentProductReferences)
  .filter(handler=>handler.startsWith("growth.operation."))
  .map(handler=>handler.replace(/^growth\.operation\./,"").replace(/@\d+$/, "")));

/** Carry unchanged old runtime bindings forward while retaining all user edits and removals. */
export function rebaseGrowthRuntimeDraft(draft: AgentConfiguration, source: AgentConfiguration, derived: AgentConfiguration): AgentConfiguration {
  const value=agentConfigurationSchema.parse(draft), old=agentConfigurationSchema.parse(source), next=agentConfigurationSchema.parse(derived);
  const rebase=(bindings: CapabilityBinding[], before: CapabilityBinding[], after: CapabilityBinding[]) => bindings.map(binding=>{
    const prior=before.find(item=>item.id===binding.id), current=after.find(item=>item.id===binding.id);
    return prior && current && requestDigest(binding)===requestDigest(prior) ? current : binding;
  });
  value.productBindings=rebase(value.productBindings,old.productBindings,next.productBindings);
  if(value.commissionableProductBindings)value.commissionableProductBindings=rebase(value.commissionableProductBindings,old.commissionableProductBindings??[],next.commissionableProductBindings??[]);
  if(value.capabilities.delegation.enabled && old.capabilities.delegation.enabled && next.capabilities.delegation.enabled){
    const before=old.capabilities.delegation.bindings,after=next.capabilities.delegation.bindings;
    value.capabilities.delegation.bindings=value.capabilities.delegation.bindings.map(role=>{
      const prior=before.find(item=>item.id===role.id), current=after.find(item=>item.id===role.id);
      if(!prior||!current||role.versionId!==prior.versionId||prior.versionId===current.versionId)return role;
      return {...role,versionId:current.versionId,...(role.versionNumber!==undefined&&current.versionNumber!==undefined?{versionNumber:current.versionNumber}:{})};
    });
  }
  return agentConfigurationSchema.parse(value);
}

/** Plan immutable clones only. The caller must lock and recheck every source before applying. */
export function planGrowthRuntimeBindingClones(input: { roots: string[]; versions: BindingPlanVersion[]; organizationId: string; tenantId: string; previous: Array<{manifest: ProductCapabilityManifest; policyRevision: string}>; next: ProductCapabilityManifest; nextPolicy: string }): { roots: Record<string,string>; clones: BindingPlanClone[] } {
  const { next } = input;
  const validManifest = (manifest: ProductCapabilityManifest) => { const { digest, ...body } = manifest; return requestDigest(body) === digest; };
  if (!validManifest(next) || next.product !== "growth" || input.previous.some(value => !validManifest(value.manifest) || value.manifest.product !== "growth") || new Set(input.previous.map(value => value.manifest.digest)).size !== input.previous.length) throw denied();
  const versions = new Map(input.versions.map(version => [version.id, version]));
  if (versions.size !== input.versions.length) throw denied();
  const mapped = new Map<string,string>(), visiting = new Set<string>(), clones: BindingPlanClone[] = [];
  const allBindings = (configuration: AgentConfiguration) => [...configuration.productBindings, ...configuration.commissionableProductBindings ?? []];
  const authorityDigest = (binding: CapabilityBinding) => { const { id: _id, alias: _alias, digest: _digest, ...authority } = binding; return requestDigest(authority); };
  const ceiling = (configuration: AgentConfiguration, ids: string[] | undefined) => ids === undefined ? configuration.productBindings : allBindings(configuration).filter(binding => ids.includes(binding.id));
  function upgrade(bindingInput: CapabilityBinding): CapabilityBinding {
    const binding = capabilityBindingSchema.parse(bindingInput), authority = binding.authority;
    if (!authority || !referenceSensitiveOperations.has(binding.definition.providerOperation)) return binding;
    if (authority.destinationProduct !== "growth" || authority.manifestDigest === next.digest) return binding;
    const old = input.previous.find(value => value.manifest.digest === authority.manifestDigest);
    if (!old) throw denied();
    const previous = old.manifest;
    if (authority.kind !== "product" || authority.destinationProduct !== "growth" || authority.policyRevision !== old.policyRevision ||
      binding.organizationId !== input.organizationId || authority.tenantId !== input.tenantId || authority.originTenantId !== input.tenantId || authority.originProduct !== "growth" ||
      binding.catalog.digest !== previous.digest || requestDigest(binding.adapter) !== requestDigest(previous.adapter)) throw denied();
    const descriptor = previous.operations.find(value => value.operation === binding.definition.providerOperation);
    const metadata = binding.definition.product;
    const target = next.operations.find(value => value.operation === binding.definition.providerOperation);
    if (!descriptor || !target || requestDigest(descriptor) !== requestDigest(target) || !metadata || requestDigest(descriptor) !== authority.descriptorDigest ||
      descriptor.handlerRef !== authority.handlerRef || metadata.handlerRef !== descriptor.handlerRef || metadata.revision !== descriptor.revision ||
      requestDigest(metadata.requiredAuthority) !== requestDigest(descriptor.requiredAuthority) || metadata.evidence !== descriptor.evidence ||
      binding.definition.description !== descriptor.description || requestDigest(binding.definition.inputSchema) !== requestDigest(descriptor.inputSchema) ||
      requestDigest(binding.definition.outputSchema) !== requestDigest(descriptor.outputSchema) || requestDigest(binding.policy) !== requestDigest(descriptor.policy) ||
      requestDigest(binding.limits) !== requestDigest(descriptor.limits)) throw denied();
    const { digest: _digest, ...bindingContent } = binding;
    const content = { ...bindingContent, adapter: next.adapter, catalog: { ...binding.catalog, digest: next.digest },
      authority: { ...authority, manifestDigest: next.digest, policyRevision: input.nextPolicy } };
    return capabilityBindingSchema.parse({ ...content, digest: requestDigest(content) });
  }
  function visit(id: string): string {
    const existing = mapped.get(id); if (existing) return existing;
    if (visiting.has(id)) throw denied();
    const version = versions.get(id); if (!version || version.organizationId !== input.organizationId || version.product !== "growth" || version.tenantId !== input.tenantId) throw denied();
    visiting.add(id);
    const parsed=agentConfigurationSchema.safeParse(version.configuration);if(!parsed.success)throw denied();
    const original = parsed.data, config = structuredClone(original);
    config.productBindings = config.productBindings.map(upgrade);
    if (config.commissionableProductBindings) config.commissionableProductBindings = config.commissionableProductBindings.map(upgrade);
    if (config.capabilities.delegation.enabled && original.capabilities.delegation.enabled) {
      const oldRoles = original.capabilities.delegation.bindings;
      config.capabilities.delegation.bindings = config.capabilities.delegation.bindings.map((child, index) => {
        const oldRole = oldRoles[index]!, childVersion = visit(child.versionId);
        const childParsed=agentConfigurationSchema.safeParse(versions.get(child.versionId)!.configuration);if(!childParsed.success)throw denied();
        const before = childParsed.data;
        const after = clones.find(clone => clone.versionId === childVersion)?.configuration ?? before;
        const oldCeiling = ceiling(original, oldRole.productBindingIds), newCeiling = ceiling(config, child.productBindingIds);
        for (const oldBinding of allBindings(before)) {
          const newBinding = allBindings(after).find(binding => binding.id === oldBinding.id); if (!newBinding) throw denied();
          const allowedBefore = oldCeiling.some(binding => authorityDigest(binding) === authorityDigest(oldBinding));
          const allowedAfter = newCeiling.some(binding => authorityDigest(binding) === authorityDigest(newBinding));
          if (allowedBefore !== allowedAfter) throw denied();
        }
        return { ...child, versionId: childVersion };
      });
    }
    visiting.delete(id);
    const target = requestDigest(config) === requestDigest(original) ? id : randomUUID();
    mapped.set(id, target);
    if (target !== id) clones.push({ sourceVersionId: id, versionId: target, configuration: agentConfigurationSchema.parse(config) });
    return target;
  }
  const roots: Record<string,string> = {};
  for (const root of input.roots) roots[root] = visit(root);
  return { roots, clones };
}
