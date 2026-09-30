use sqlx::{postgres::PgConnection, Postgres, Transaction};
use thiserror::Error;

pub const RLS_SCOPE_SETTING: &str = "analytics.authorized_scope_ids";
pub const RLS_GRANT_SETTING: &str = "analytics.authorization_grant_id";

#[derive(Debug, Error, Eq, PartialEq)]
pub enum AuthorizationContextError {
    #[error("authorization context requires at least one scope")]
    EmptyScopes,
    #[error("authorization context contains invalid scope id {0}")]
    InvalidScopeId(i64),
    #[error("authorization context requires a grant id")]
    MissingGrantId,
}

pub fn encode_scope_ids(scope_ids: &[i64]) -> Result<String, AuthorizationContextError> {
    if scope_ids.is_empty() {
        return Err(AuthorizationContextError::EmptyScopes);
    }
    let mut normalized = scope_ids.to_vec();
    if normalized.iter().any(|scope_id| *scope_id <= 0) {
        let invalid = normalized
            .into_iter()
            .find(|scope_id| *scope_id <= 0)
            .expect("an invalid scope id exists");
        return Err(AuthorizationContextError::InvalidScopeId(invalid));
    }
    normalized.sort_unstable();
    normalized.dedup();
    Ok(format!(
        "{{{}}}",
        normalized
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(",")
    ))
}

pub async fn set_authorization_context(
    connection: &mut PgConnection,
    scope_ids: &[i64],
    grant_id: &str,
) -> Result<(), AuthorizationContextErrorOrSqlx> {
    let encoded_scope_ids = encode_scope_ids(scope_ids)?;
    if grant_id.trim().is_empty() {
        return Err(AuthorizationContextError::MissingGrantId.into());
    }
    sqlx::query("SELECT analytics.set_authorization_context($1::bigint[], $2)")
        .bind(encoded_scope_ids)
        .bind(grant_id)
        .execute(connection)
        .await?;
    Ok(())
}

pub async fn set_authorization_context_transaction(
    transaction: &mut Transaction<'_, Postgres>,
    scope_ids: &[i64],
    grant_id: &str,
) -> Result<(), AuthorizationContextErrorOrSqlx> {
    let encoded_scope_ids = encode_scope_ids(scope_ids)?;
    if grant_id.trim().is_empty() {
        return Err(AuthorizationContextError::MissingGrantId.into());
    }
    sqlx::query("SELECT analytics.set_authorization_context($1::bigint[], $2)")
        .bind(encoded_scope_ids)
        .bind(grant_id)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub async fn clear_authorization_context(connection: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT analytics.clear_authorization_context()")
        .execute(connection)
        .await?;
    Ok(())
}

pub type AuthorizationContextErrorOrSqlx = AuthorizationContextErrorOrDatabase;

#[derive(Debug, Error)]
pub enum AuthorizationContextErrorOrDatabase {
    #[error(transparent)]
    Context(#[from] AuthorizationContextError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

#[cfg(test)]
mod tests {
    use super::{encode_scope_ids, AuthorizationContextError};

    #[test]
    fn encodes_sorted_deduplicated_postgres_scope_array() {
        assert_eq!(encode_scope_ids(&[4, 2, 4, 3]).unwrap(), "{2,3,4}");
    }

    #[test]
    fn rejects_empty_or_non_positive_scope_contexts() {
        assert_eq!(
            encode_scope_ids(&[]).unwrap_err(),
            AuthorizationContextError::EmptyScopes
        );
        assert_eq!(
            encode_scope_ids(&[2, 0]).unwrap_err(),
            AuthorizationContextError::InvalidScopeId(0)
        );
    }
}
