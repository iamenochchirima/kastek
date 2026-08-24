use actix_web::{HttpResponse, ResponseError};
use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: &'static str,
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
    UnsupportedPrincipal(String),
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    TooManyRequests(String),
    ServiceUnavailable(String),
    BadGateway(String),
    GatewayTimeout(String),
    Internal(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadRequest(message) => write!(f, "bad request: {message}"),
            Self::Unauthorized => write!(f, "unauthorized"),
            Self::UnsupportedPrincipal(message) => write!(f, "unsupported principal: {message}"),
            Self::Forbidden(message) => write!(f, "forbidden: {message}"),
            Self::NotFound(message) => write!(f, "not found: {message}"),
            Self::Conflict(message) => write!(f, "conflict: {message}"),
            Self::TooManyRequests(message) => write!(f, "too many requests: {message}"),
            Self::ServiceUnavailable(message) => write!(f, "service unavailable: {message}"),
            Self::BadGateway(message) => write!(f, "bad gateway: {message}"),
            Self::GatewayTimeout(message) => write!(f, "gateway timeout: {message}"),
            Self::Internal(message) => write!(f, "internal: {message}"),
        }
    }
}

impl ResponseError for AppError {
    fn error_response(&self) -> HttpResponse {
        let code = self.code();
        match self {
            Self::BadRequest(message) => HttpResponse::BadRequest().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::Unauthorized => HttpResponse::Unauthorized().json(ErrorResponse {
                error: "Unauthorized".to_string(),
                code,
            }),
            Self::UnsupportedPrincipal(message) => HttpResponse::Forbidden().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::Forbidden(message) => HttpResponse::Forbidden().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::NotFound(message) => HttpResponse::NotFound().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::Conflict(message) => HttpResponse::Conflict().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::TooManyRequests(message) => HttpResponse::TooManyRequests()
                .insert_header(("retry-after", "60"))
                .json(ErrorResponse {
                    error: message.clone(),
                    code,
                }),
            Self::ServiceUnavailable(message) => {
                HttpResponse::ServiceUnavailable().json(ErrorResponse {
                    error: message.clone(),
                    code,
                })
            }
            Self::BadGateway(message) => HttpResponse::BadGateway().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::GatewayTimeout(message) => HttpResponse::GatewayTimeout().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
            Self::Internal(message) => HttpResponse::InternalServerError().json(ErrorResponse {
                error: message.clone(),
                code,
            }),
        }
    }
}

impl AppError {
    /// Stable machine-readable error code for API clients. The human message
    /// remains useful for logs/UI, while callers can branch on this value
    /// without parsing wording that may evolve.
    pub fn code(&self) -> &'static str {
        match self {
            Self::BadRequest(_) => "bad_request",
            Self::Unauthorized => "unauthorized",
            Self::UnsupportedPrincipal(_) => "unsupported_principal",
            Self::Forbidden(_) => "forbidden",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::TooManyRequests(_) => "rate_limited",
            Self::ServiceUnavailable(_) => "service_unavailable",
            Self::BadGateway(_) => "bad_gateway",
            Self::GatewayTimeout(_) => "gateway_timeout",
            Self::Internal(_) => "internal_error",
        }
    }

    pub fn provider_http_failure(status: reqwest::StatusCode) -> Option<Self> {
        (status == reqwest::StatusCode::TOO_MANY_REQUESTS)
            .then(|| Self::TooManyRequests("Provider rate limit exceeded".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::AppError;
    use actix_web::ResponseError;

    #[test]
    fn public_error_codes_are_stable_and_rate_limits_are_retryable() {
        assert_eq!(AppError::BadRequest("x".to_string()).code(), "bad_request");
        assert_eq!(
            AppError::UnsupportedPrincipal("x".to_string()).code(),
            "unsupported_principal"
        );
        assert_eq!(
            AppError::UnsupportedPrincipal("x".to_string())
                .error_response()
                .status(),
            actix_web::http::StatusCode::FORBIDDEN
        );
        assert_eq!(
            AppError::TooManyRequests("x".to_string()).code(),
            "rate_limited"
        );
        let response = AppError::TooManyRequests("x".to_string()).error_response();
        assert_eq!(
            response.status(),
            actix_web::http::StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(response.headers().get("retry-after").unwrap(), "60");
    }

    #[test]
    fn provider_429s_use_the_stable_rate_limit_error() {
        let error = AppError::provider_http_failure(reqwest::StatusCode::TOO_MANY_REQUESTS)
            .expect("429 should map to a rate-limit error");
        assert_eq!(error.code(), "rate_limited");
        assert!(AppError::provider_http_failure(reqwest::StatusCode::BAD_GATEWAY).is_none());
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        log::error!("sqlx error: {:?}", error);
        Self::Internal("Database operation failed".to_string())
    }
}

impl From<bcrypt::BcryptError> for AppError {
    fn from(error: bcrypt::BcryptError) -> Self {
        log::error!("bcrypt error: {:?}", error);
        Self::Internal("Password operation failed".to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(error: reqwest::Error) -> Self {
        log::error!("http error: {:?}", error);
        Self::Internal("External request failed".to_string())
    }
}
