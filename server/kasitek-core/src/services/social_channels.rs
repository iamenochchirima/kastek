//! Social channel capability metadata.
//!
//! Provider connection state and channel capability descriptions are kept
//! separate from post publishing and OAuth code. This module is intentionally
//! transport-neutral so the product and capability adapters can share it.

use serde_json::{json, Value};

pub fn platform_capabilities(platform: &str) -> Value {
    match platform {
        "FACEBOOK" | "INSTAGRAM" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": true,
            "supportsDMs": true,
            "supportsAnalytics": true,
            "supportsInbox": true,
            "supportsVariants": true,
        }),
        "THREADS" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "TIKTOK" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "BLUESKY" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "LINKEDIN" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "X" => json!({
            "canPublish": true,
            "supportsManualPublish": true,
            "supportsMediaUpload": true,
            "supportsComments": true,
            "supportsDMs": false,
            "supportsAnalytics": true,
            "supportsInbox": false,
            "supportsVariants": true,
        }),
        "WHATSAPP_STATUS" => json!({
            "canPublish": true,
            "supportsManualPublish": false,
            "supportsMediaUpload": true,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": false,
        }),
        _ => json!({
            "canPublish": false,
            "supportsManualPublish": false,
            "supportsMediaUpload": false,
            "supportsComments": false,
            "supportsDMs": false,
            "supportsAnalytics": false,
            "supportsInbox": false,
            "supportsVariants": false,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::platform_capabilities;

    #[test]
    fn channel_capabilities_are_provider_specific_and_safe_by_default() {
        assert_eq!(platform_capabilities("INSTAGRAM")["canPublish"], true);
        assert_eq!(platform_capabilities("THREADS")["supportsDMs"], false);
        assert_eq!(platform_capabilities("unknown")["canPublish"], false);
    }
}
