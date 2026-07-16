use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha512;

use crate::error::AppError;
use crate::services::billing_provider::{
    BillingProvider, CheckoutRequest, CheckoutResponse, ProviderEvent, VerifiedTransaction,
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
            customer_id: data
                .get("customer")
                .and_then(Value::as_object)
                .and_then(|customer| customer.get("customer_code"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            subscription_id: Self::subscription_code(data),
        })
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
}
