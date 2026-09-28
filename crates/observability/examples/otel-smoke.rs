use opentelemetry::global;
use tracing::Instrument;

#[tokio::main]
async fn main() {
    observability::init_with_service("info", "kasitek-observability-smoke");

    let span = tracing::info_span!("kasitek.local.smoke", kasitek.smoke = true);
    async {
        observability::in_span("http", "smoke.http", async {}).await;
        observability::in_span("database", "smoke.database", async {}).await;
        observability::provider_span("synthetic-provider", "request", async {}).await;
        observability::in_span("worker", "smoke.worker", async {}).await;
        let expected_error: Result<(), &str> =
            observability::result_span("smoke", "smoke.expected_error", async {
                Err("expected telemetry smoke failure")
            })
            .await;
        if expected_error.is_err() {
            log::warn!(target: "kasitek.observability.smoke", "event=kasitek.local.smoke.expected.error outcome=handled");
        }
        global::meter("kasitek-observability-smoke")
            .u64_counter("kasitek.local.smoke.count")
            .build()
            .add(1, &[]);
        tracing::info!(event = "kasitek.local.smoke.event", outcome = "success");
        log::info!(target: "kasitek.observability.smoke", "event=kasitek.local.smoke outcome=success");
    }
    .instrument(span)
    .await;

    observability::shutdown();
}
