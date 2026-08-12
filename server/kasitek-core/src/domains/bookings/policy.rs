use sqlx::PgPool;

use crate::{error::AppError, identity::request_context::RequestContext, services::orgs};

pub async fn require_workspace_admin(
    context: &RequestContext,
    pool: &PgPool,
) -> Result<(), AppError> {
    let user_id = context.user_id.as_deref().ok_or_else(|| {
        AppError::Forbidden("Booking service administration requires a workspace user".to_string())
    })?;
    orgs::require_admin(pool, &context.organization_id, user_id).await
}
