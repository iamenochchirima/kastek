use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::error::AppError;

#[derive(Debug)]
pub struct CheckoutRequest {
    pub email: String,
    pub plan_code: String,
    pub reference: String,
    pub callback_url: String,
    pub metadata: Value,
}

#[derive(Debug)]
pub struct CheckoutResponse {
    pub authorization_url: String,
    pub reference: String,
}

#[derive(Debug, PartialEq)]
pub struct VerifiedTransaction {
    pub successful: bool,
    pub reference: String,
    pub amount_minor: Option<i64>,
    pub currency: Option<String>,
    pub customer_id: Option<String>,
    pub subscription_id: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum ProviderSubscriptionState {
    Active,
    NonRenewing,
    Attention,
    Completed,
    Cancelled,
    Unknown(String),
}

#[derive(Debug, PartialEq)]
pub struct VerifiedSubscription {
    pub subscription_id: String,
    pub state: ProviderSubscriptionState,
    pub current_period_start: Option<DateTime<Utc>>,
    pub current_period_end: Option<DateTime<Utc>>,
}

#[derive(Debug, PartialEq)]
pub enum ProviderEvent {
    ChargeSucceeded {
        reference: String,
        customer_id: Option<String>,
        subscription_id: Option<String>,
    },
    SubscriptionCreated {
        subscription_id: String,
        customer_id: String,
        plan_code: String,
    },
    SubscriptionNotRenewing {
        subscription_id: String,
    },
    SubscriptionDisabled {
        subscription_id: String,
    },
    InvoicePaymentFailed {
        subscription_id: String,
    },
    RefundProcessed {
        transaction_reference: String,
        amount_minor: Option<i64>,
    },
    DisputeOpened {
        transaction_reference: String,
    },
    Ignored,
}

#[async_trait]
pub trait BillingProvider: Send + Sync {
    fn name(&self) -> &'static str;
    async fn initialize_checkout(
        &self,
        request: CheckoutRequest,
    ) -> Result<CheckoutResponse, AppError>;
    async fn verify_transaction(&self, reference: &str) -> Result<VerifiedTransaction, AppError>;
    async fn verify_subscription(
        &self,
        subscription_id: &str,
    ) -> Result<VerifiedSubscription, AppError>;
    fn verify_webhook(&self, payload: &[u8], signature: &str) -> bool;
    fn parse_webhook(&self, event: &Value) -> Result<ProviderEvent, AppError>;
}
