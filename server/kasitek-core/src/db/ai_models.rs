//! Domain-owned AI/social ideation request models.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct SocialIdeasRequest {
    pub topic: Option<String>,
    pub objective: Option<String>,
    pub channels: Option<Vec<String>>,
}
#[derive(Debug, Deserialize)]
pub struct SocialCaptionRequest {
    pub prompt: Option<String>,
    pub title: Option<String>,
    pub channels: Option<Vec<String>>,
    #[serde(rename = "currentContent")]
    pub current_content: Option<String>,
}
