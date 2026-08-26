//! Domain-owned authentication and admin session models.
//!
//! User/session persistence rows and auth/admin request/response DTOs live
//! beside the identity boundary while `db::models` keeps compatibility re-exports.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct User {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
    pub password: Option<String>,
    #[sqlx(rename = "emailVerified")]
    pub email_verified: Option<DateTime<Utc>>,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct AdminUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub password: String,
    pub role: String,
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct SessionRecord {
    pub id: String,
    #[sqlx(rename = "sessionToken")]
    pub session_token: String,
    #[sqlx(rename = "userId")]
    pub user_id: String,
    pub expires: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct UserProfileResponse {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
    #[serde(rename = "emailVerified")]
    pub email_verified: Option<DateTime<Utc>>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

impl From<User> for UserProfileResponse {
    fn from(value: User) -> Self {
        Self {
            id: value.id,
            name: value.name,
            email: value.email,
            phone: value.phone,
            image: value.image,
            email_verified: value.email_verified,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AdminUserResponse {
    pub id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

impl From<AdminUser> for AdminUserResponse {
    fn from(value: AdminUser) -> Self {
        Self {
            id: value.id,
            name: value.name,
            email: value.email,
            role: value.role,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct SignupRequest {
    pub email: String,
    pub password: String,
    pub name: Option<String>,
    pub phone: Option<String>,
    #[serde(rename = "phoneVerified")]
    pub phone_verified: Option<bool>,
    #[serde(rename = "referralCode")]
    pub referral_code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct AccountCheckRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResendVerificationRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendOtpRequest {
    pub phone: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct VerifyOtpRequest {
    pub phone: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PasswordSetupRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetPasswordRequest {
    pub email: Option<String>,
    pub token: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub name: Option<String>,
    pub phone: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProfileBootstrapResponse {
    pub user: UserProfileResponse,
    #[serde(rename = "hasPassword")]
    pub has_password: bool,
}

#[derive(Debug, Deserialize)]
pub struct OnboardingPhoneRequest {
    pub phone: Option<String>,
    #[serde(rename = "phoneVerified")]
    pub phone_verified: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ChangeEmailRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(rename = "currentPassword")]
    pub current_password: Option<String>,
    #[serde(rename = "nextPassword")]
    pub next_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminForgotPasswordRequest {
    pub email: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AdminResetPasswordRequest {
    pub email: Option<String>,
    pub token: Option<String>,
    pub password: Option<String>,
}
