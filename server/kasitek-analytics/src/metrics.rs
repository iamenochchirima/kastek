use std::sync::atomic::{AtomicU64, Ordering};

use actix_web::{http::header, web, HttpRequest, HttpResponse, Responder};

use crate::{
    config::AnalyticsConfig,
    contracts::{ProcessKind, SERVICE_NAME},
};

/// Process-level metrics deliberately contain no customer or resource identifiers.
/// Domain counters belong to the analytics fact and projection layers added later.
#[derive(Default)]
pub struct ProcessMetrics {
    liveness_checks_total: AtomicU64,
    readiness_checks_total: AtomicU64,
    readiness_failures_total: AtomicU64,
    metrics_scrapes_total: AtomicU64,
    metrics_denied_total: AtomicU64,
}

impl ProcessMetrics {
    pub fn record_liveness(&self) {
        self.liveness_checks_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_readiness(&self, ready: bool) {
        self.readiness_checks_total.fetch_add(1, Ordering::Relaxed);
        if !ready {
            self.readiness_failures_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_scrape(&self, authorized: bool) {
        self.metrics_scrapes_total.fetch_add(1, Ordering::Relaxed);
        if !authorized {
            self.metrics_denied_total.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn render(&self, process: ProcessKind) -> String {
        let labels = format!(
            "service=\"{SERVICE_NAME}\",process=\"{}\"",
            process.as_str()
        );
        format!(
            "# HELP kasitek_analytics_process_info Analytics process information.\n\
# TYPE kasitek_analytics_process_info gauge\n\
kasitek_analytics_process_info{{{labels}}} 1\n\
# HELP kasitek_analytics_liveness_checks_total Liveness probes received.\n\
# TYPE kasitek_analytics_liveness_checks_total counter\n\
kasitek_analytics_liveness_checks_total{{{labels}}} {}\n\
# HELP kasitek_analytics_readiness_checks_total Readiness probes received.\n\
# TYPE kasitek_analytics_readiness_checks_total counter\n\
kasitek_analytics_readiness_checks_total{{{labels}}} {}\n\
# HELP kasitek_analytics_readiness_failures_total Readiness probes that found a dependency unavailable.\n\
# TYPE kasitek_analytics_readiness_failures_total counter\n\
kasitek_analytics_readiness_failures_total{{{labels}}} {}\n\
# HELP kasitek_analytics_metrics_scrapes_total Metrics endpoint requests received.\n\
# TYPE kasitek_analytics_metrics_scrapes_total counter\n\
kasitek_analytics_metrics_scrapes_total{{{labels}}} {}\n\
# HELP kasitek_analytics_metrics_denied_total Metrics endpoint requests rejected by authentication.\n\
# TYPE kasitek_analytics_metrics_denied_total counter\n\
kasitek_analytics_metrics_denied_total{{{labels}}} {}\n",
            self.liveness_checks_total.load(Ordering::Relaxed),
            self.readiness_checks_total.load(Ordering::Relaxed),
            self.readiness_failures_total.load(Ordering::Relaxed),
            self.metrics_scrapes_total.load(Ordering::Relaxed),
            self.metrics_denied_total.load(Ordering::Relaxed),
        )
    }
}

#[derive(Clone, Debug)]
pub struct MetricsAccess {
    token: Option<String>,
}

impl MetricsAccess {
    pub fn from_config(config: &AnalyticsConfig) -> Self {
        Self {
            token: config.metrics_token.clone(),
        }
    }

    fn authorized(&self, request: &HttpRequest) -> bool {
        let Some(token) = self.token.as_deref() else {
            return false;
        };
        let expected = format!("Bearer {token}");
        request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == expected)
    }
}

pub async fn endpoint(
    request: HttpRequest,
    process: web::Data<ProcessKind>,
    metrics: web::Data<ProcessMetrics>,
    access: web::Data<MetricsAccess>,
) -> impl Responder {
    let authorized = access.authorized(&request);
    metrics.record_scrape(authorized);
    if !authorized {
        return HttpResponse::Unauthorized()
            .insert_header((header::WWW_AUTHENTICATE, "Bearer"))
            .finish();
    }

    HttpResponse::Ok()
        .content_type("text/plain; version=0.0.4; charset=utf-8")
        .body(metrics.render(**process))
}

#[cfg(test)]
mod tests {
    use actix_web::test as actix_test;

    use super::{MetricsAccess, ProcessMetrics};
    use crate::{config::AnalyticsConfig, contracts::ProcessKind};

    fn config(token: Option<&str>) -> AnalyticsConfig {
        AnalyticsConfig::from_lookup(|name| match name {
            "ANALYTICS_DATABASE_URL" => Some("postgres://localhost/analytics".to_string()),
            "ANALYTICS_METRICS_TOKEN" => token.map(str::to_string),
            _ => None,
        })
        .expect("test config")
    }

    #[test]
    fn metrics_require_an_explicit_bearer_token() {
        let access = MetricsAccess::from_config(&config(Some("secret")));
        let request = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer secret"))
            .to_http_request();
        assert!(access.authorized(&request));

        let request = actix_test::TestRequest::default()
            .insert_header(("Authorization", "Bearer wrong"))
            .to_http_request();
        assert!(!access.authorized(&request));

        let access = MetricsAccess::from_config(&config(None));
        let request = actix_test::TestRequest::default().to_http_request();
        assert!(!access.authorized(&request));
    }

    #[test]
    fn rendered_metrics_use_only_process_labels() {
        let metrics = ProcessMetrics::default();
        metrics.record_liveness();
        metrics.record_readiness(false);
        let output = metrics.render(ProcessKind::Api);
        assert!(output.contains("kasitek_analytics_process_info{service=\"kasitek-analytics\",process=\"analytics-api\"} 1"));
        assert!(output.contains("kasitek_analytics_readiness_failures_total"));
        assert!(!output.contains("organization_id"));
    }
}
