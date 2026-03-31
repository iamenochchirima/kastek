use actix_web::cookie::{Cookie, SameSite};
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
    pub web_push_vapid_public_key: Option<String>,
    pub web_push_vapid_private_key: Option<String>,
    pub web_push_subject: String,
    pub whatsapp_call_provider: String,
    pub whatsapp_call_signaling_url: Option<String>,
    pub whatsapp_call_ice_servers_json: Option<String>,
    pub whatsapp_call_bridge_token: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Result<Self, env::VarError> {
        let frontend_url =
            env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());

        Ok(Self {
            port: env::var("PORT")
                .unwrap_or_else(|_| "8080".to_string())
                .parse()
                .unwrap_or(8080),
            environment: env::var("ENVIRONMENT").unwrap_or_else(|_| "development".to_string()),
            database_url: env::var("DATABASE_URL")?,
            database_max_connections: env::var("DATABASE_MAX_CONNECTIONS")
                .unwrap_or_else(|_| "10".to_string())
                .parse()
                .unwrap_or(10),
            frontend_url: frontend_url.clone(),
            auth_url: frontend_url,
            session_secret: env::var("SESSION_SECRET")
                .or_else(|_| env::var("AUTH_SECRET"))
                .unwrap_or_else(|_| "kasitek-dev-session-secret".to_string()),
            resend_api_key: env::var("AUTH_RESEND_KEY").ok(),
            resend_from_email: env::var("RESEND_FROM_EMAIL")
                .unwrap_or_else(|_| "KasiTek <onboarding@resend.dev>".to_string()),
            zoomconnect_send_url: env::var("ZOOMCONNECT_SEND_URL").ok(),
            web_push_vapid_public_key: env::var("WEB_PUSH_VAPID_PUBLIC_KEY").ok(),
            web_push_vapid_private_key: env::var("WEB_PUSH_VAPID_PRIVATE_KEY").ok(),
            web_push_subject: env::var("WEB_PUSH_SUBJECT")
                .unwrap_or_else(|_| "mailto:hello@kasitek.com".to_string()),
            whatsapp_call_provider: env::var("WHATSAPP_CALL_PROVIDER")
                .unwrap_or_else(|_| "stub".to_string()),
            whatsapp_call_signaling_url: env::var("WHATSAPP_CALL_SIGNALING_URL").ok(),
            whatsapp_call_ice_servers_json: env::var("WHATSAPP_CALL_ICE_SERVERS_JSON").ok(),
            whatsapp_call_bridge_token: env::var("WHATSAPP_CALL_BRIDGE_TOKEN").ok(),
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
