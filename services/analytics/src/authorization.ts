import type { PoolClient } from 'pg';
export const RLS_SCOPE_SETTING = 'analytics.authorized_scope_ids';
export const RLS_GRANT_SETTING = 'analytics.authorization_grant_id';
export class AuthorizationContextError extends Error {}
export function encodeScopeIds(ids: readonly bigint[]): string {
  if (!ids.length)
    throw new AuthorizationContextError(
      'authorization context requires at least one scope',
    );
  const invalid = ids.find((id) => id <= 0n);
  if (invalid !== undefined)
    throw new AuthorizationContextError(
      `authorization context contains invalid scope id ${invalid}`,
    );
  return `{${[...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(',')}}`;
}
export async function setAuthorizationContext(
  connection: PoolClient,
  ids: readonly bigint[],
  grantId: string,
): Promise<void> {
  const encoded = encodeScopeIds(ids);
  if (!grantId.trim())
    throw new AuthorizationContextError(
      'authorization context requires a grant id',
    );
  await connection.query(
    'SELECT analytics.set_authorization_context($1::bigint[], $2)',
    [encoded, grantId],
  );
}
export const setAuthorizationContextTransaction = setAuthorizationContext;
export async function clearAuthorizationContext(
  connection: PoolClient,
): Promise<void> {
  await connection.query('SELECT analytics.clear_authorization_context()');
}
