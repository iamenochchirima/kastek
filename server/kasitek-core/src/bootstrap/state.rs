use std::sync::Arc;

use actions::{catalog::initial_registry, ActionRegistry};
use sqlx::PgPool;

use crate::config::AppConfig;

/// Shared process dependencies. HTTP handlers still receive the pool and
/// configuration directly during the incremental migration; new adapters use
/// this state so dependencies do not become additional globals.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: AppConfig,
    pub http_client: reqwest::Client,
    pub action_registry: Arc<ActionRegistry>,
}

impl AppState {
    pub fn new(pool: PgPool, config: AppConfig) -> Self {
        let action_registry = initial_registry().expect("built-in action catalog must be valid");
        Self {
            pool,
            config,
            http_client: reqwest::Client::new(),
            action_registry: Arc::new(action_registry),
        }
    }
}
