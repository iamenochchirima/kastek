use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha512;

use crate::error::AppError;
use crate::services::billing_provider::{
    BillingProvider, CheckoutRequest, CheckoutResponse, ProviderEvent, ProviderSubscriptionState,
    VerifiedSubscription, VerifiedTransaction,
};

type HmacSha512 = Hmac<Sha512>;

pub struct PaystackProvider {
    secret_key: String,
    api_base_url: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct ApiResponse<T> {
    status: bool,
    message: String,
    data: Option<T>,
}

#[derive(Deserialize)]
struct CheckoutData {
    authorization_url: String,
    reference: String,
}

impl PaystackProvider {
    pub fn new(secret_key: impl Into<String>, api_base_url: impl Into<String>) -> Self {
        Self {
            secret_key: secret_key.into(),
            api_base_url: api_base_url.into().trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
        }
    }

    fn subscription_code(data: &Value) -> Option<String> {
        data.get("subscription_code")
            .and_then(Value::as_str)
            .or_else(|| {
                data.get("subscription")
                    .and_then(Value::as_object)
                    .and_then(|subscription| subscription.get("subscription_code"))
                    .and_then(Value::as_str)
            })
            .map(ToString::to_string)
    }

    fn parse_verified_transaction(data: &Value) -> Result<VerifiedTransaction, AppError> {
        let reference = data
            .get("reference")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| AppError::BadRequest("Paystack reference is missing".to_string()))?;
        Ok(VerifiedTransaction {
            successful: data.get("status").and_then(Value::as_str) == Some("success"),
            reference: reference.to_string(),
            amount_minor: data.get("amount").and_then(Value::as_i64),
            currency: data
                .get("currency")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            customer_id: data
                .get("customer")
                .and_then(Value::as_object)
                .and_then(|customer| customer.get("customer_code"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            subscription_id: Self::subscription_code(data),
        })
    }

    fn parse_datetime(value: Option<&Value>) -> Option<DateTime<Utc>> {
        value
            .and_then(Value::as_str)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
    }

    fn parse_verified_subscription(data: &Value) -> Result<VerifiedSubscription, AppError> {
        let subscription_id = Self::subscription_code(data).ok_or_else(|| {
            AppError::BadRequest("Paystack subscription code is missing".to_string())
        })?;
        let provider_status = data
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let state = match provider_status {
            "active" => ProviderSubscriptionState::Active,
            "non-renewing" => ProviderSubscriptionState::NonRenewing,
            "attention" => ProviderSubscriptionState::Attention,
            "completed" => ProviderSubscriptionState::Completed,
            "cancelled" => ProviderSubscriptionState::Cancelled,
            status => ProviderSubscriptionState::Unknown(status.to_string()),
        };
        let invoice = data.get("most_recent_invoice").and_then(Value::as_object);
        Ok(VerifiedSubscription {
            subscription_id,
            state,
            current_period_start: Self::parse_datetime(
                invoice.and_then(|value| value.get("period_start")),
            ),
            current_period_end: Self::parse_datetime(
                invoice.and_then(|value| value.get("period_end")),
            )
            .or_else(|| Self::parse_datetime(data.get("next_payment_date"))),
        })
    }

    fn transaction_reference(data: &Value) -> Option<String> {
        data.get("transaction_reference")
            .and_then(Value::as_str)
            .or_else(|| {
                data.get("transaction")
                    .and_then(Value::as_object)
                    .and_then(|transaction| transaction.get("reference"))
                    .and_then(Value::as_str)
            })
            .map(ToString::to_string)
    }
}

#[async_trait]
impl BillingProvider for PaystackProvider {
    fn name(&self) -> &'static str {
        "paystack"
    }

    async fn initialize_checkout(
        &self,
        request: CheckoutRequest,
    ) -> Result<CheckoutResponse, AppError> {
        let response = self
            .client
            .post(format!("{}/transaction/initialize", self.api_base_url))
            .bearer_auth(&self.secret_key)
            .json(&json!({
                "email": request.email,
                "plan": request.plan_code,
                "reference": request.reference,
                "callback_url": request.callback_url,
                "metadata": request.metadata,
            }))
            .send()
            .await?;
        let status = response.status();
        let body: ApiResponse<CheckoutData> = response.json().await?;
        let data = body
            .data
            .filter(|_| status.is_success() && body.status)
            .ok_or_else(|| AppError::BadRequest(body.message))?;
        Ok(CheckoutResponse {
            authorization_url: data.authorization_url,
            reference: data.reference,
        })
    }

    async fn verify_transaction(&self, reference: &str) -> Result<VerifiedTransaction, AppError> {
        let response = self
            .client
            .get(format!(
                "{}/transaction/verify/{}",
                self.api_base_url,
                urlencoding::encode(reference)
            ))
            .bearer_auth(&self.secret_key)
            .send()
            .await?;
        let status = response.status();
        let body: ApiResponse<Value> = response.json().await?;
        let data = body
            .data
            .filter(|_| status.is_success() && body.status)
            .ok_or_else(|| AppError::BadRequest(body.message))?;
        Self::parse_verified_transaction(&data)
    }

    async fn verify_subscription(
        &self,
        subscription_id: &str,
    ) -> Result<VerifiedSubscription, AppError> {
        let response = self
            .client
            .get(format!(
                "{}/subscription/{}",
                self.api_base_url,
                urlencoding::encode(subscription_id)
            ))
            .bearer_auth(&self.secret_key)
            .send()
            .await?;
        let status = response.status();
        let body: ApiResponse<Value> = response.json().await?;
        let data = body
            .data
            .filter(|_| status.is_success() && body.status)
            .ok_or_else(|| AppError::BadRequest(body.message))?;
        Self::parse_verified_subscription(&data)
    }

    fn verify_webhook(&self, payload: &[u8], signature: &str) -> bool {
        let Ok(signature) = hex::decode(signature.trim()) else {
            return false;
        };
        let Ok(mut mac) = HmacSha512::new_from_slice(self.secret_key.as_bytes()) else {
            return false;
        };
        mac.update(payload);
        mac.verify_slice(&signature).is_ok()
    }

    fn parse_webhook(&self, event: &Value) -> Result<ProviderEvent, AppError> {
        let event_type = event
            .get("event")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest("Paystack event type is missing".to_string()))?;
        let data = event
            .get("data")
            .ok_or_else(|| AppError::BadRequest("Paystack webhook data is missing".to_string()))?;
        let subscription_id = Self::subscription_code(data);
        let parsed = match event_type {
            "charge.success" if data.get("status").and_then(Value::as_str) == Some("success") => {
                let reference = data
                    .get("reference")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::BadRequest("Paystack reference is missing".to_string())
                    })?;
                ProviderEvent::ChargeSucceeded {
                    reference: reference.to_string(),
                    customer_id: data
                        .get("customer")
                        .and_then(Value::as_object)
                        .and_then(|customer| customer.get("customer_code"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    subscription_id,
                }
            }
            "subscription.create" => ProviderEvent::SubscriptionCreated {
                subscription_id: subscription_id.ok_or_else(|| {
                    AppError::BadRequest("Paystack subscription code is missing".to_string())
                })?,
                customer_id: data
                    .get("customer")
                    .and_then(Value::as_object)
                    .and_then(|customer| customer.get("customer_code"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::BadRequest("Paystack customer code is missing".to_string())
                    })?
                    .to_string(),
                plan_code: data
                    .get("plan")
                    .and_then(Value::as_object)
                    .and_then(|plan| plan.get("plan_code"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        AppError::BadRequest("Paystack plan code is missing".to_string())
                    })?
                    .to_string(),
            },
            "subscription.not_renew" => ProviderEvent::SubscriptionNotRenewing {
                subscription_id: subscription_id.ok_or_else(|| {
                    AppError::BadRequest("Paystack subscription code is missing".to_string())
                })?,
            },
            "subscription.disable" => ProviderEvent::SubscriptionDisabled {
                subscription_id: subscription_id.ok_or_else(|| {
                    AppError::BadRequest("Paystack subscription code is missing".to_string())
                })?,
            },
            "invoice.payment_failed" => ProviderEvent::InvoicePaymentFailed {
                subscription_id: subscription_id.ok_or_else(|| {
                    AppError::BadRequest("Paystack subscription code is missing".to_string())
                })?,
            },
            "refund.processed" => ProviderEvent::RefundProcessed {
                transaction_reference: Self::transaction_reference(data).ok_or_else(|| {
                    AppError::BadRequest(
                        "Paystack refund transaction reference is missing".to_string(),
                    )
                })?,
                amount_minor: data
                    .get("amount")
                    .and_then(|amount| amount.as_i64().or_else(|| amount.as_str()?.parse().ok())),
            },
            "charge.dispute.create" => ProviderEvent::DisputeOpened {
                transaction_reference: Self::transaction_reference(data).ok_or_else(|| {
                    AppError::BadRequest(
                        "Paystack dispute transaction reference is missing".to_string(),
                    )
                })?,
            },
            _ => ProviderEvent::Ignored,
        };
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_signatures_and_normalizes_subscription_events() {
        let provider = PaystackProvider::new("secret", "https://example.test");
        let payload = br#"{"event":"charge.success"}"#;
        let mut mac = HmacSha512::new_from_slice(b"secret").unwrap();
        mac.update(payload);
        let signature = hex::encode(mac.finalize().into_bytes());
        assert!(provider.verify_webhook(payload, &signature));
        assert!(!provider.verify_webhook(b"modified", &signature));

        let event =
            json!({"event":"subscription.not_renew","data":{"subscription_code":"SUB_123"}});
        assert_eq!(
            provider.parse_webhook(&event).unwrap(),
            ProviderEvent::SubscriptionNotRenewing {
                subscription_id: "SUB_123".to_string()
            }
        );
    }

    #[test]
    fn normalizes_verified_transactions_without_card_data() {
        let data = json!({
            "status": "success",
            "reference": "ks_123",
            "customer": {"customer_code": "CUS_123"},
            "subscription": {"subscription_code": "SUB_123"},
            "authorization": {"last4": "4081"}
        });
        assert_eq!(
            PaystackProvider::parse_verified_transaction(&data).unwrap(),
            VerifiedTransaction {
                successful: true,
                reference: "ks_123".to_string(),
                amount_minor: None,
                currency: None,
                customer_id: Some("CUS_123".to_string()),
                subscription_id: Some("SUB_123".to_string()),
            }
        );
        assert!(
            PaystackProvider::parse_verified_transaction(&json!({"status": "success"})).is_err()
        );
    }

    #[test]
    fn ignores_unsuccessful_charge_events() {
        let provider = PaystackProvider::new("secret", "https://example.test");
        let event = json!({
            "event": "charge.success",
            "data": {"status": "failed", "reference": "ks_123"}
        });
        assert_eq!(
            provider.parse_webhook(&event).unwrap(),
            ProviderEvent::Ignored
        );
    }

    #[test]
    fn normalizes_subscription_states_and_periods() {
        let active = json!({
            "subscription_code": "SUB_123",
            "status": "attention",
            "most_recent_invoice": {
                "period_start": "2026-07-01T00:00:00Z",
                "period_end": "2026-08-01T00:00:00Z"
            }
        });
        let subscription = PaystackProvider::parse_verified_subscription(&active).unwrap();
        assert_eq!(subscription.subscription_id, "SUB_123");
        assert_eq!(subscription.state, ProviderSubscriptionState::Attention);
        assert_eq!(
            subscription.current_period_end.unwrap().to_rfc3339(),
            "2026-08-01T00:00:00+00:00"
        );

        let unknown = json!({"subscription_code": "SUB_456", "status": "paused"});
        assert_eq!(
            PaystackProvider::parse_verified_subscription(&unknown)
                .unwrap()
                .state,
            ProviderSubscriptionState::Unknown("paused".to_string())
        );
    }

    #[test]
    fn normalizes_refund_and_dispute_events() {
        let provider = PaystackProvider::new("secret", "https://example.test");
        let refund = json!({
            "event": "refund.processed",
            "data": {"transaction_reference": "ks_123", "amount": "25000"}
        });
        assert_eq!(
            provider.parse_webhook(&refund).unwrap(),
            ProviderEvent::RefundProcessed {
                transaction_reference: "ks_123".to_string(),
                amount_minor: Some(25_000),
            }
        );

        let dispute = json!({
            "event": "charge.dispute.create",
            "data": {"transaction": {"reference": "ks_456"}}
        });
        assert_eq!(
            provider.parse_webhook(&dispute).unwrap(),
            ProviderEvent::DisputeOpened {
                transaction_reference: "ks_456".to_string(),
            }
        );
    }
}
