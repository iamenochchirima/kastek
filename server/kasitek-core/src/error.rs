use actix_web::{HttpResponse, ResponseError};
use serde::Serialize;
use std::fmt;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    Unauthorized,
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
        match self {
            Self::BadRequest(message) => HttpResponse::BadRequest().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::Unauthorized => HttpResponse::Unauthorized().json(ErrorResponse {
                error: "Unauthorized".to_string(),
            }),
            Self::Forbidden(message) => HttpResponse::Forbidden().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::NotFound(message) => HttpResponse::NotFound().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::Conflict(message) => HttpResponse::Conflict().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::TooManyRequests(message) => HttpResponse::TooManyRequests()
                .insert_header(("retry-after", "60"))
                .json(ErrorResponse {
                    error: message.clone(),
                }),
            Self::ServiceUnavailable(message) => {
                HttpResponse::ServiceUnavailable().json(ErrorResponse {
                    error: message.clone(),
                })
            }
            Self::BadGateway(message) => HttpResponse::BadGateway().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::GatewayTimeout(message) => HttpResponse::GatewayTimeout().json(ErrorResponse {
                error: message.clone(),
            }),
            Self::Internal(message) => HttpResponse::InternalServerError().json(ErrorResponse {
                error: message.clone(),
            }),
        }
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
