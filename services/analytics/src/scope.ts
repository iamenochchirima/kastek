export const MAX_REPORTING_GRANT_VALIDITY_SECONDS = 120;
export type ScopeKind =
  'core_organization' | 'tenant_workspace' | 'tenant_client';
export type ScopeStatus = 'active' | 'suspended' | 'deleted';
export type PrincipalType = 'user' | 'service_identity' | 'agent_installation';
export type DescendantMode = 'none' | 'all' | 'explicit';
export interface ScopeNode {
  scope_id: bigint;
  kind: ScopeKind;
  root_scope_id: bigint;
  parent_scope_id: bigint | null;
  status: ScopeStatus;
}
export interface ReportingGrant {
  grant_id: string;
  issuer: string;
  audience: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_id: bigint;
  root_scope_id: bigint;
  descendant_mode: DescendantMode;
  explicit_descendant_scope_ids: bigint[];
  permissions: Set<string>;
  metric_keys: string[];
  dimension_keys: string[];
  policy_version: string;
  issued_at: Date;
  not_before: Date;
  expires_at: Date;
  correlation_id: string | null;
  revoked_at: Date | null;
}
export interface AuthorizedScope {
  requested_scope_id: bigint;
  authorized_scope_ids: bigint[];
}
export class ScopeAuthorizationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string): never => {
  throw new ScopeAuthorizationError(code, message);
};
const invalidGrant = (grant: ReportingGrant, message: string) =>
  fail('InvalidGrant', `grant ${grant.grant_id} is invalid: ${message}`);
const sortIds = (ids: bigint[]) =>
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
export function validateGrant(
  grant: ReportingGrant,
  audience: string,
  now: Date,
): void {
  if (
    ![
      grant.grant_id,
      grant.issuer,
      grant.audience,
      grant.principal_id,
      grant.policy_version,
    ].every((v) => v.trim()) ||
    grant.scope_id <= 0n ||
    grant.root_scope_id <= 0n
  )
    invalidGrant(grant, 'required fields are missing');
  if (grant.audience !== audience)
    fail('InvalidAudience', 'grant audience is not accepted');
  if (grant.revoked_at !== null) invalidGrant(grant, 'grant is revoked');
  if (
    grant.issued_at > grant.not_before ||
    grant.expires_at <= grant.not_before
  )
    invalidGrant(grant, 'grant timestamps are inconsistent');
  if (+grant.expires_at - +grant.issued_at > 120000)
    fail('GrantValidityTooLong', 'grant validity exceeds 120 seconds');
  if (now < grant.not_before || now >= grant.expires_at)
    fail('GrantNotCurrent', 'grant is not currently valid');
  if (
    grant.descendant_mode === 'explicit' &&
    !grant.explicit_descendant_scope_ids.length
  )
    invalidGrant(
      grant,
      'explicit descendant mode requires at least one descendant',
    );
  if (
    grant.descendant_mode !== 'explicit' &&
    grant.explicit_descendant_scope_ids.length
  )
    invalidGrant(grant, 'explicit descendants are only valid in explicit mode');
}
const debugKind = (kind: ScopeKind) =>
  ({
    core_organization: 'CoreOrganization',
    tenant_workspace: 'TenantWorkspace',
    tenant_client: 'TenantClient',
  })[kind];
export class ScopeCatalog {
  private readonly scopes = new Map<bigint, ScopeNode>();
  constructor(scopes: Iterable<ScopeNode>) {
    for (const scope of scopes) {
      if (scope.scope_id <= 0n || scope.root_scope_id <= 0n)
        fail('InvalidScopeId', `scope ${scope.scope_id} is invalid`);
      if (this.scopes.has(scope.scope_id))
        fail('DuplicateScope', `scope ${scope.scope_id} is duplicated`);
      this.scopes.set(scope.scope_id, scope);
    }
    this.validateHierarchy();
  }
  scope(id: bigint): ScopeNode | undefined {
    return this.scopes.get(id);
  }
  isDescendant(ancestor: bigint, id: bigint): boolean {
    if (ancestor === id) return true;
    let current = id;
    const seen = new Set<bigint>();
    while (this.scopes.has(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      const parent = this.scopes.get(current)!.parent_scope_id;
      if (parent === null) return false;
      if (parent === ancestor) return true;
      current = parent;
    }
    return false;
  }
  activeDescendants(ancestor: bigint): bigint[] {
    return sortIds(
      [...this.scopes.values()]
        .filter((scope) => {
          if (!this.isDescendant(ancestor, scope.scope_id)) return false;
          try {
            this.authorizableScope(scope.scope_id);
            return true;
          } catch {
            return false;
          }
        })
        .map((s) => s.scope_id),
    );
  }
  private authorizableScope(id: bigint): ScopeNode {
    const scope = this.scopes.get(id);
    if (!scope) return fail('InvalidScopeId', `scope ${id} is invalid`);
    if (scope.status !== 'active')
      fail(
        'ScopeUnavailable',
        `scope ${id} is not available for authorization`,
      );
    let parent = scope.parent_scope_id;
    while (parent !== null) {
      const node = this.scopes.get(parent);
      if (!node)
        return fail(
          'MissingParent',
          `scope ${id} references missing parent ${parent}`,
        );
      if (node.status !== 'active')
        fail(
          'ScopeUnavailable',
          `scope ${parent} is not available for authorization`,
        );
      parent = node.parent_scope_id;
    }
    return scope;
  }
  private validateHierarchy(): void {
    for (const scope of [...this.scopes.values()].sort((a, b) =>
      a.scope_id < b.scope_id ? -1 : 1,
    )) {
      if (scope.parent_scope_id === null) {
        if (scope.root_scope_id !== scope.scope_id)
          fail(
            'InvalidRoot',
            `scope ${scope.scope_id} has an invalid root ${scope.root_scope_id}`,
          );
        continue;
      }
      const parentId = scope.parent_scope_id;
      if (parentId === scope.scope_id)
        fail(
          'SelfParent',
          `scope ${scope.scope_id} references itself as its parent`,
        );
      const parent = this.scopes.get(parentId);
      if (!parent)
        return fail(
          'MissingParent',
          `scope ${scope.scope_id} references missing parent ${parentId}`,
        );
      if (scope.root_scope_id !== parent.root_scope_id)
        fail(
          'InvalidRoot',
          `scope ${scope.scope_id} has an invalid root ${scope.root_scope_id}`,
        );
      const expected =
        scope.kind === 'tenant_client' ? 'tenant_workspace' : null;
      if (expected !== parent.kind)
        fail(
          'InvalidParentKind',
          `scope ${scope.scope_id} has parent kind ${debugKind(parent.kind)}, expected ${debugKind(expected ?? parent.kind)}`,
        );
      let current = scope.scope_id;
      const seen = new Set<bigint>();
      while (this.scopes.has(current)) {
        if (seen.has(current))
          fail(
            'HierarchyCycle',
            `scope hierarchy contains a cycle at ${current}`,
          );
        seen.add(current);
        const node = this.scopes.get(current)!;
        if (node.parent_scope_id === null) break;
        current = node.parent_scope_id;
      }
    }
  }
  authorize(
    grant: ReportingGrant,
    audience: string,
    now: Date,
    requested: bigint,
    permission: string,
  ): AuthorizedScope {
    validateGrant(grant, audience, now);
    if (!grant.permissions.has(permission))
      fail('MissingPermission', `grant permission ${permission} is missing`);
    const granted = this.authorizableScope(grant.scope_id);
    if (granted.root_scope_id !== grant.root_scope_id)
      invalidGrant(grant, 'grant root does not match its selected scope');
    const scope = this.authorizableScope(requested);
    if (scope.root_scope_id !== grant.root_scope_id)
      fail('ScopeOutsideGrant', `scope ${requested} is outside the grant`);
    if (grant.descendant_mode === 'explicit')
      for (const id of grant.explicit_descendant_scope_ids) {
        const node = this.authorizableScope(id);
        if (
          node.root_scope_id !== grant.root_scope_id ||
          !this.isDescendant(grant.scope_id, id)
        )
          fail('ScopeOutsideGrant', `scope ${id} is outside the grant`);
      }
    const allowed =
      grant.descendant_mode === 'none'
        ? requested === grant.scope_id
        : grant.descendant_mode === 'all'
          ? this.isDescendant(grant.scope_id, requested)
          : grant.explicit_descendant_scope_ids.includes(requested) &&
            this.isDescendant(grant.scope_id, requested);
    if (!allowed)
      fail('ScopeOutsideGrant', `scope ${requested} is outside the grant`);
    return {
      requested_scope_id: requested,
      authorized_scope_ids:
        grant.descendant_mode === 'none'
          ? [grant.scope_id]
          : grant.descendant_mode === 'all'
            ? this.activeDescendants(grant.scope_id)
            : sortIds([
                ...new Set([
                  grant.scope_id,
                  ...grant.explicit_descendant_scope_ids,
                ]),
              ]),
    };
  }
}
