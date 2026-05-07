use actix_web::cookie::{Cookie, SameSite};
use ::config::{env_optional, env_string_or, env_u16_or, env_u32_or};
use std::env;

pub const USER_SESSION_COOKIE: &str = "kasitek_session";
pub const ADMIN_SESSION_COOKIE: &str = "kasitek_admin_session";

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub environment: String,
    pub database_url: String,
    pub database_max_connections: u32,
    pub frontend_url: String,
    pub auth_url: String,
    #[allow(dead_code)]
    pub session_secret: String,
    pub resend_api_key: Option<String>,
    pub resend_from_email: String,
    pub zoomconnect_send_url: Option<String>,
    pub kasitek_calls_url: Option<String>,
    pub web_push_vapid_public_key: Option<String>,
    pub web_push_vapid_private_key: Option<String>,
    pub web_push_subject: String,
    pub whatsapp_call_provider: String,
    pub whatsapp_call_signaling_url: Option<String>,
    pub whatsapp_call_bridge_token: Option<String>,
    pub livekit_url: Option<String>,
    pub livekit_api_key: Option<String>,
    pub livekit_api_secret: Option<String>,
    pub livekit_token_ttl_seconds: u64,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, env::VarError> {
        let frontend_url = env_string_or("FRONTEND_URL", "http://localhost:3000");

        Ok(Self {
            port: env_u16_or("PORT", 4000),
            environment: env_string_or("ENVIRONMENT", "development"),
            database_url: env_optional("KASITEK_CORE_DATABASE_URL")
                .or_else(|| env_optional("DATABASE_URL"))
                .ok_or(env::VarError::NotPresent)?,
            database_max_connections: env_u32_or("DATABASE_MAX_CONNECTIONS", 10),
            frontend_url: frontend_url.clone(),
            auth_url: frontend_url,
            session_secret: env_optional("SESSION_SECRET")
                .or_else(|| env_optional("AUTH_SECRET"))
                .unwrap_or_else(|| "kasitek-dev-session-secret".to_string()),
            resend_api_key: env_optional("AUTH_RESEND_KEY"),
            resend_from_email: env_string_or("RESEND_FROM_EMAIL", "KasiTek <onboarding@resend.dev>"),
            zoomconnect_send_url: env_optional("ZOOMCONNECT_SEND_URL"),
            kasitek_calls_url: env_optional("KASITEK_CALLS_URL"),
            web_push_vapid_public_key: env_optional("WEB_PUSH_VAPID_PUBLIC_KEY"),
            web_push_vapid_private_key: env_optional("WEB_PUSH_VAPID_PRIVATE_KEY"),
            web_push_subject: env_string_or("WEB_PUSH_SUBJECT", "mailto:hello@kasitek.com"),
            whatsapp_call_provider: env_string_or("WHATSAPP_CALL_PROVIDER", "stub"),
            whatsapp_call_signaling_url: env_optional("WHATSAPP_CALL_SIGNALING_URL"),
            whatsapp_call_bridge_token: env_optional("WHATSAPP_CALL_BRIDGE_TOKEN"),
            livekit_url: env_optional("LIVEKIT_URL"),
            livekit_api_key: env_optional("LIVEKIT_API_KEY"),
            livekit_api_secret: env_optional("LIVEKIT_API_SECRET"),
            livekit_token_ttl_seconds: env::var("LIVEKIT_TOKEN_TTL_SECONDS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(600),
        })
    }

    pub fn is_production(&self) -> bool {
        self.environment.eq_ignore_ascii_case("production")
    }

    pub fn web_push_configured(&self) -> bool {
        self.web_push_vapid_public_key.is_some() && self.web_push_vapid_private_key.is_some()
    }

    pub fn build_user_session_cookie(&self, value: &str) -> Cookie<'static> {
        self.build_cookie(USER_SESSION_COOKIE, value)
    }

    pub fn clear_user_session_cookie(&self) -> Cookie<'static> {
        self.clear_cookie(USER_SESSION_COOKIE)
    }

    pub fn build_admin_session_cookie(&self, value: &str) -> Cookie<'static> {
        self.build_cookie(ADMIN_SESSION_COOKIE, value)
    }

    pub fn clear_admin_session_cookie(&self) -> Cookie<'static> {
        self.clear_cookie(ADMIN_SESSION_COOKIE)
    }

    fn build_cookie(&self, name: &str, value: &str) -> Cookie<'static> {
        let mut cookie = Cookie::build(name.to_string(), value.to_string())
            .path("/")
            .http_only(true)
            .same_site(if self.is_production() {
                SameSite::None
            } else {
                SameSite::Lax
            })
            .secure(self.is_production())
            .finish();

        if let Ok(domain) = env::var("COOKIE_DOMAIN") {
            cookie.set_domain(domain);
        }

        cookie
    }

    fn clear_cookie(&self, name: &str) -> Cookie<'static> {
        let mut cookie = Cookie::build(name.to_string(), "")
            .path("/")
            .http_only(true)
            .same_site(if self.is_production() {
                SameSite::None
            } else {
                SameSite::Lax
            })
            .secure(self.is_production())
            .max_age(actix_web::cookie::time::Duration::seconds(0))
            .finish();

        if let Ok(domain) = env::var("COOKIE_DOMAIN") {
            cookie.set_domain(domain);
        }

        cookie
    }
}
