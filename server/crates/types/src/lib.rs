use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub timestamp: DateTime<Utc>,
}
