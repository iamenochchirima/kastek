use std::{
    env,
    future::{ready, Future, Ready},
    io::{IsTerminal, Write},
    pin::Pin,
    sync::OnceLock,
    time::{Duration, Instant},
};

use actix_web::{
    body::MessageBody,
    dev::{Service, ServiceRequest, ServiceResponse, Transform},
    http::header::{HeaderName, HeaderValue},
    middleware::Logger,
    Error,
};
use env_logger::{Builder, Env, Target, WriteStyle};
use log::{Level, Record};
use opentelemetry::{
    global,
    metrics::{Counter, Histogram, UpDownCounter},
    propagation::{Extractor, Injector},
    trace::TracerProvider as _,
    Context, KeyValue,
};
use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
use opentelemetry_sdk::{
    logs::{
        log_processor_with_async_runtime::BatchLogProcessor,
        BatchConfigBuilder as LogBatchConfigBuilder, SdkLoggerProvider,
    },
    metrics::{periodic_reader_with_async_runtime::PeriodicReader, SdkMeterProvider},
    propagation::TraceContextPropagator,
    runtime,
    trace::{BatchConfigBuilder as TraceBatchConfigBuilder, Sampler, SdkTracerProvider},
    Resource,
};
use regex::{Captures, Regex};
use serde_json::json;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub use tracing;
pub use tracing_actix_web::{DefaultRootSpanBuilder, RootSpanBuilder, TracingLogger};

const UNKNOWN_VALUE: &str = "unknown";
const MAX_LEGACY_LOG_MESSAGE_LENGTH: usize = 4_096;

static TELEMETRY_REDACTION_PATTERN: OnceLock<Regex> = OnceLock::new();

fn telemetry_redaction_pattern() -> &'static Regex {
    TELEMETRY_REDACTION_PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?ix)
            (?P<bearer>Bearer\s+)[^\s,;&]+
            |(?P<query>[?&](?:token|access[_-]?token|refresh[_-]?token|api[_-]?key|key|code|signature|password|secret)=)[^&\s]+
            |(?P<field>(?:authorization|token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=])\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^,\s;&]+)
            "#,
        )
        .expect("telemetry redaction pattern must compile")
    })
}

/// Bounds legacy log messages and removes common credential material before they reach either
/// stdout or the OpenTelemetry log bridge.
pub fn redact_telemetry_text(value: impl AsRef<str>, max_length: usize) -> String {
    let bounded: String = value.as_ref().chars().take(max_length).collect();
    telemetry_redaction_pattern()
        .replace_all(&bounded, |captures: &Captures<'_>| {
            if let Some(prefix) = captures.name("query") {
                format!("{}[REDACTED]", prefix.as_str())
            } else if let Some(prefix) = captures.name("field") {
                format!("{}[REDACTED]", prefix.as_str())
            } else {
                "Bearer [REDACTED]".to_string()
            }
        })
        .into_owned()
}

struct Providers {
    tracer: &'static SdkTracerProvider,
    meter: &'static SdkMeterProvider,
    logger: &'static SdkLoggerProvider,
}

static PROVIDERS: OnceLock<Providers> = OnceLock::new();
static REQUEST_COUNT: OnceLock<Counter<u64>> = OnceLock::new();
static REQUEST_DURATION: OnceLock<Histogram<f64>> = OnceLock::new();
static REQUEST_ERRORS: OnceLock<Counter<u64>> = OnceLock::new();
static REQUEST_IN_FLIGHT: OnceLock<UpDownCounter<i64>> = OnceLock::new();
static OPERATION_COUNT: OnceLock<Counter<u64>> = OnceLock::new();
static OPERATION_ERRORS: OnceLock<Counter<u64>> = OnceLock::new();
static OPERATION_DURATION: OnceLock<Histogram<f64>> = OnceLock::new();
static OPERATION_IN_FLIGHT: OnceLock<UpDownCounter<i64>> = OnceLock::new();
static OPERATION_RETRIES: OnceLock<Counter<u64>> = OnceLock::new();
static DEPENDENCY_FAILURES: OnceLock<Counter<u64>> = OnceLock::new();
static QUEUE_AGE: OnceLock<Histogram<f64>> = OnceLock::new();

fn env_value(names: &[&str]) -> String {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        .unwrap_or_else(|| UNKNOWN_VALUE.to_string())
}

fn env_truthy(name: &str) -> bool {
    matches!(
        env::var(name)
            .ok()
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn otel_export_configured() -> bool {
    !env_truthy("OTEL_SDK_DISABLED")
        && [
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        ]
        .iter()
        .any(|name| {
            env::var(name)
                .ok()
                .is_some_and(|value| !value.trim().is_empty())
        })
}

/// Builds the resource shared by all signals emitted by a service process.
pub fn telemetry_resource(service_name: &str) -> Resource {
    let service_name = env::var("OTEL_SERVICE_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| service_name.to_string());
    let version = env_value(&["KASITEK_VERSION", "PLATFORM_VERSION"]);
    let release_id = env_value(&["KASITEK_RELEASE_ID", "RELEASE_ID", "KASITEK_VERSION"]);
    let commit_sha = env_value(&["KASITEK_COMMIT_SHA", "GIT_SHA", "COMMIT_SHA"]);
    let artifact_digest = env_value(&["KASITEK_ARTIFACT_DIGEST", "ARTIFACT_DIGEST"]);
    let instance_id = env_value(&["KASITEK_INSTANCE_ID", "RAILWAY_REPLICA_ID", "HOSTNAME"]);
    let environment = env_value(&[
        "OTEL_DEPLOYMENT_ENVIRONMENT",
        "DEPLOYMENT_ENVIRONMENT",
        "ENVIRONMENT",
        "RAILWAY_ENVIRONMENT_NAME",
    ]);

    Resource::builder()
        .with_service_name(service_name)
        .with_attributes([
            KeyValue::new("service.version", version),
            KeyValue::new("deployment.environment.name", environment.clone()),
            KeyValue::new("kasitek.release_id", release_id),
            KeyValue::new("kasitek.commit_sha", commit_sha),
            KeyValue::new("kasitek.artifact_digest", artifact_digest),
            KeyValue::new("kasitek.environment", environment),
            KeyValue::new("service.instance.id", instance_id),
            KeyValue::new("process.runtime.name", "rust"),
            KeyValue::new("process.pid", i64::from(std::process::id())),
        ])
        .build()
}

fn sampler_from_environment() -> Sampler {
    let ratio = env::var("OTEL_TRACES_SAMPLER_ARG")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(1.0);

    match env::var("OTEL_TRACES_SAMPLER")
        .unwrap_or_else(|_| "parentbased_always_on".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "always_off" => Sampler::AlwaysOff,
        "always_on" => Sampler::AlwaysOn,
        "traceidratio" => Sampler::TraceIdRatioBased(ratio),
        "parentbased_always_off" => Sampler::ParentBased(Box::new(Sampler::AlwaysOff)),
        "parentbased_traceidratio" => {
            Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(ratio)))
        }
        _ => Sampler::ParentBased(Box::new(Sampler::AlwaysOn)),
    }
}

fn tracing_filter(default_filter: &str) -> EnvFilter {
    let value = env::var("RUST_LOG")
        .ok()
        .or_else(|| env::var("LOG_LEVEL").ok())
        .unwrap_or_else(|| default_filter.to_string());
    EnvFilter::new(value)
}

struct RedactingLogger<L> {
    inner: L,
}

impl<L> log::Log for RedactingLogger<L>
where
    L: log::Log,
{
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.inner.enabled(record.metadata()) {
            return;
        }

        let message =
            redact_telemetry_text(record.args().to_string(), MAX_LEGACY_LOG_MESSAGE_LENGTH);
        self.inner.log(
            &log::Record::builder()
                .args(format_args!("{message}"))
                .level(record.level())
                .target(record.target())
                .module_path(record.module_path())
                .file(record.file())
                .line(record.line())
                .build(),
        );
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

fn init_otel(default_filter: &str, service_name: &str) -> Result<(), String> {
    log::set_boxed_logger(Box::new(RedactingLogger {
        inner: tracing_log::LogTracer::new(),
    }))
    .map_err(|error| format!("failed to initialize log-to-tracing bridge: {error}"))?;
    log::set_max_level(log::LevelFilter::Trace);
    let resource = telemetry_resource(service_name);
    let span_exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .build()
        .map_err(|error| format!("failed to build OTLP span exporter: {error}"))?;
    let metric_exporter = opentelemetry_otlp::MetricExporter::builder()
        .with_http()
        .build()
        .map_err(|error| format!("failed to build OTLP metric exporter: {error}"))?;
    let log_exporter = opentelemetry_otlp::LogExporter::builder()
        .with_http()
        .build()
        .map_err(|error| format!("failed to build OTLP log exporter: {error}"))?;

    let tracer_provider = Box::leak(Box::new(
        SdkTracerProvider::builder()
            .with_resource(resource.clone())
            .with_sampler(sampler_from_environment())
            .with_span_processor(
                opentelemetry_sdk::trace::span_processor_with_async_runtime::BatchSpanProcessor::builder(
                    span_exporter,
                    runtime::Tokio,
                )
                .with_batch_config(
                    TraceBatchConfigBuilder::default()
                        .with_max_queue_size(2_048)
                        .with_max_export_batch_size(512)
                        .with_scheduled_delay(Duration::from_secs(5))
                        .with_max_export_timeout(Duration::from_secs(5))
                        .build(),
                )
                .build(),
            )
            .build(),
    ));
    let meter_provider = Box::leak(Box::new(
        SdkMeterProvider::builder()
            .with_resource(resource.clone())
            .with_reader(
                PeriodicReader::builder(metric_exporter, runtime::Tokio)
                    .with_interval(Duration::from_secs(30))
                    .with_timeout(Duration::from_secs(5))
                    .build(),
            )
            .build(),
    ));
    let logger_provider = Box::leak(Box::new(
        SdkLoggerProvider::builder()
            .with_resource(resource)
            .with_log_processor(
                BatchLogProcessor::builder(log_exporter, runtime::Tokio)
                    .with_batch_config(
                        LogBatchConfigBuilder::default()
                            .with_max_queue_size(2_048)
                            .with_max_export_batch_size(512)
                            .with_scheduled_delay(Duration::from_secs(5))
                            .with_max_export_timeout(Duration::from_secs(5))
                            .build(),
                    )
                    .build(),
            )
            .build(),
    ));

    global::set_tracer_provider(tracer_provider.clone());
    global::set_meter_provider(meter_provider.clone());
    global::set_text_map_propagator(TraceContextPropagator::new());
    PROVIDERS
        .set(Providers {
            tracer: tracer_provider,
            meter: meter_provider,
            logger: logger_provider,
        })
        .map_err(|_| "OpenTelemetry providers were already initialized".to_string())?;

    let otel_layer = tracing_opentelemetry::layer()
        .with_tracer(tracer_provider.tracer(service_name.to_string()));
    let log_layer = OpenTelemetryTracingBridge::new(logger_provider);
    tracing_subscriber::registry()
        .with(tracing_filter(default_filter))
        .with(otel_layer)
        .with(log_layer)
        .with(
            tracing_subscriber::fmt::layer()
                .json()
                .with_target(true)
                .with_current_span(true)
                .with_span_list(false),
        )
        .try_init()
        .map_err(|error| format!("failed to initialize tracing subscriber: {error}"))
}

fn structured_logs_enabled() -> bool {
    match env::var("LOG_FORMAT") {
        Ok(value) if value.eq_ignore_ascii_case("json") => true,
        Ok(value) if value.eq_ignore_ascii_case("pretty") => false,
        Ok(value) if value.eq_ignore_ascii_case("text") => false,
        _ => {
            env::var_os("RAILWAY_ENVIRONMENT").is_some()
                || env::var_os("RAILWAY_PROJECT_ID").is_some()
        }
    }
}

fn request_log_colors_enabled() -> bool {
    match env::var("LOG_COLOR") {
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "always" | "true" | "1") => true,
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "never" | "false" | "0") => {
            false
        }
        _ => !structured_logs_enabled() && (std::io::stdout().is_terminal() || local_environment()),
    }
}

fn local_environment() -> bool {
    let environment = env::var("ENVIRONMENT")
        .or_else(|_| env::var("TENANT_SERVER_ENVIRONMENT"))
        .unwrap_or_else(|_| "development".to_string());
    matches!(
        environment.to_ascii_lowercase().as_str(),
        "development" | "dev" | "local" | "test"
    )
}

fn status_color(status: u16) -> &'static str {
    match status {
        200..=299 => "32", // green
        300..=399 => "36", // cyan
        400..=499 => "33", // yellow
        500..=599 => "31", // red
        _ => "37",         // white
    }
}

fn format_status(status: u16, colorize: bool) -> String {
    if colorize {
        format!("\u{1b}[{}m{}\u{1b}[0m", status_color(status), status)
    } else {
        status.to_string()
    }
}

fn access_log_status(record: &Record<'_>) -> Option<u16> {
    if record.target() != "actix_web::middleware::logger" {
        return None;
    }

    let message = record.args().to_string();
    parse_status_token(message.split_whitespace().next()?)
}

fn parse_status_token(token: &str) -> Option<u16> {
    let start = token.find('m').map_or(0, |index| index + 1);
    let end = token[start..]
        .find('\u{1b}')
        .map_or(token.len(), |index| start + index);
    token[start..end].parse().ok()
}

fn display_level(record: &Record<'_>) -> Level {
    match access_log_status(record) {
        Some(500..=599) => Level::Error,
        Some(400..=499) => Level::Warn,
        Some(300..=399) | Some(200..=299) => Level::Info,
        _ => record.level(),
    }
}

fn level_color(level: Level) -> &'static str {
    match level {
        Level::Error => "31", // red
        Level::Warn => "33",  // yellow
        Level::Info => "32",  // green
        Level::Debug => "34", // blue
        Level::Trace => "36", // cyan
    }
}

fn format_level(level: Level, colorize: bool) -> String {
    let text = format!("{:<5}", level.as_str());
    if colorize {
        format!("\u{1b}[{}m{}\u{1b}[0m", level_color(level), text)
    } else {
        text
    }
}

/// Builds the shared access logger used by the HTTP servers.
///
/// The legacy access record intentionally contains only the response status and duration. The
/// request span owns bounded method/route fields, keeping raw URLs, query strings, remote
/// addresses, referers, and user agents out of the compatibility log path.
pub fn http_logger() -> Logger {
    let colorize = request_log_colors_enabled();
    Logger::new(r#"%{STATUS}xo %T"#)
        .custom_response_replace("STATUS", move |response: &ServiceResponse| {
            format_status(response.status().as_u16(), colorize)
        })
}

struct HeaderExtractor<'a>(&'a actix_web::http::header::HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

/// Builds request spans with the same trace propagation as the upstream middleware while keeping
/// query strings and network identifiers out of the exported span attributes.
pub struct KasitekRootSpanBuilder;

impl RootSpanBuilder for KasitekRootSpanBuilder {
    fn on_request_start(request: &ServiceRequest) -> tracing::Span {
        let method = request.method().as_str().to_string();
        let route = request
            .match_pattern()
            .unwrap_or_else(|| "unmatched".to_string())
            .chars()
            .take(128)
            .collect::<String>();
        let target = request.uri().path().chars().take(256).collect::<String>();
        let correlation_id = request
            .headers()
            .get(&CORRELATION_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| is_safe_correlation_id(value))
            .unwrap_or(UNKNOWN_VALUE);
        let span = tracing::info_span!(
            "HTTP request",
            http.method = %method,
            http.route = %route,
            http.flavor = ?request.version(),
            http.target = %target,
            http.status_code = tracing::field::Empty,
            otel.name = %format!("{} {}", method, route),
            otel.kind = "server",
            otel.status_code = tracing::field::Empty,
            trace_id = tracing::field::Empty,
            request_id = tracing::field::Empty,
            exception.message = tracing::field::Empty,
            exception.details = tracing::field::Empty,
            correlation_id = %correlation_id,
        );
        let parent = global::get_text_map_propagator(|propagator| {
            propagator.extract(&HeaderExtractor(request.headers()))
        });
        let _ = tracing_opentelemetry::OpenTelemetrySpanExt::set_parent(&span, parent);
        span
    }

    fn on_request_end<B: MessageBody>(
        span: tracing::Span,
        outcome: &Result<ServiceResponse<B>, Error>,
    ) {
        DefaultRootSpanBuilder::on_request_end(span, outcome);
    }
}

/// Adds a server span around every Actix request and extracts W3C `traceparent`/`tracestate`.
pub fn http_tracing_logger() -> TracingLogger<KasitekRootSpanBuilder> {
    TracingLogger::new()
}

fn metric_route(request: &ServiceRequest) -> String {
    request
        .match_pattern()
        .unwrap_or_else(|| "unmatched".to_string())
        .chars()
        .take(128)
        .collect()
}

fn request_counter() -> Counter<u64> {
    REQUEST_COUNT
        .get_or_init(|| {
            global::meter("kasitek.http")
                .u64_counter("http.server.request.count")
                .with_description("Completed HTTP server requests")
                .build()
        })
        .clone()
}

fn request_duration() -> Histogram<f64> {
    REQUEST_DURATION
        .get_or_init(|| {
            global::meter("kasitek.http")
                .f64_histogram("http.server.request.duration")
                .with_description("HTTP server request duration in seconds")
                .with_unit("s")
                .build()
        })
        .clone()
}

fn request_errors() -> Counter<u64> {
    REQUEST_ERRORS
        .get_or_init(|| {
            global::meter("kasitek.http")
                .u64_counter("http.server.request.error.count")
                .with_description("HTTP server requests that failed with a server error")
                .build()
        })
        .clone()
}

fn request_in_flight() -> UpDownCounter<i64> {
    REQUEST_IN_FLIGHT
        .get_or_init(|| {
            global::meter("kasitek.http")
                .i64_up_down_counter("http.server.request.in_flight")
                .with_description("HTTP server requests currently in progress")
                .build()
        })
        .clone()
}

fn operation_counter() -> Counter<u64> {
    OPERATION_COUNT
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .u64_counter("kasitek.operation.count")
                .with_description("Completed instrumented service operations")
                .build()
        })
        .clone()
}

fn operation_errors() -> Counter<u64> {
    OPERATION_ERRORS
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .u64_counter("kasitek.operation.error.count")
                .with_description("Instrumented service operations that failed")
                .build()
        })
        .clone()
}

fn operation_duration() -> Histogram<f64> {
    OPERATION_DURATION
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .f64_histogram("kasitek.operation.duration")
                .with_description("Instrumented service operation duration in seconds")
                .with_unit("s")
                .build()
        })
        .clone()
}

fn operation_in_flight() -> UpDownCounter<i64> {
    OPERATION_IN_FLIGHT
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .i64_up_down_counter("kasitek.operation.in_flight")
                .with_description("Instrumented service operations currently in progress")
                .build()
        })
        .clone()
}

fn operation_retries() -> Counter<u64> {
    OPERATION_RETRIES
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .u64_counter("kasitek.operation.retry.count")
                .with_description("Retries observed for instrumented service operations")
                .build()
        })
        .clone()
}

fn dependency_failures() -> Counter<u64> {
    DEPENDENCY_FAILURES
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .u64_counter("kasitek.dependency.failure.count")
                .with_description("Instrumented dependency operations that failed")
                .build()
        })
        .clone()
}

fn queue_age() -> Histogram<f64> {
    QUEUE_AGE
        .get_or_init(|| {
            global::meter("kasitek.operations")
                .f64_histogram("kasitek.queue.age")
                .with_description("Age of work when it is claimed from a queue in seconds")
                .with_unit("s")
                .build()
        })
        .clone()
}

struct InFlightGuard<const N: usize> {
    counter: UpDownCounter<i64>,
    attributes: [KeyValue; N],
    active: bool,
}

impl<const N: usize> InFlightGuard<N> {
    fn new(counter: UpDownCounter<i64>, attributes: [KeyValue; N]) -> Self {
        counter.add(1, &attributes);
        Self {
            counter,
            attributes,
            active: true,
        }
    }

    fn finish(&mut self) {
        if self.active {
            self.counter.add(-1, &self.attributes);
            self.active = false;
        }
    }
}

impl<const N: usize> Drop for InFlightGuard<N> {
    fn drop(&mut self) {
        self.finish();
    }
}

fn operation_attributes(kind: &'static str, name: &'static str) -> [KeyValue; 2] {
    [
        KeyValue::new("operation.kind", kind),
        KeyValue::new("operation.name", name),
    ]
}

fn record_operation(
    kind: &'static str,
    name: &'static str,
    outcome: &'static str,
    duration: Duration,
) {
    let attributes = [
        KeyValue::new("operation.kind", kind),
        KeyValue::new("operation.name", name),
        KeyValue::new("outcome", outcome),
    ];
    operation_counter().add(1, &attributes);
    operation_duration().record(duration.as_secs_f64(), &attributes);
    if outcome == "error" {
        operation_errors().add(1, &attributes);
    }
}

/// Records bounded HTTP service metrics without making request handling depend on export health.
#[derive(Clone, Copy, Debug, Default)]
pub struct TelemetryMetrics;

impl<S, B> Transform<S, ServiceRequest> for TelemetryMetrics
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Transform = TelemetryMetricsService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(TelemetryMetricsService { service }))
    }
}

#[doc(hidden)]
pub struct TelemetryMetricsService<S> {
    service: S,
}

impl<S, B> Service<ServiceRequest> for TelemetryMetricsService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

    actix_web::dev::forward_ready!(service);

    fn call(&self, request: ServiceRequest) -> Self::Future {
        let method = request.method().as_str().to_string();
        let route = metric_route(&request);
        let started = Instant::now();
        let in_flight_attributes = [
            KeyValue::new("http.request.method", method.clone()),
            KeyValue::new("http.route", route.clone()),
        ];
        let mut in_flight = InFlightGuard::new(request_in_flight(), in_flight_attributes);
        let future = self.service.call(request);

        Box::pin(async move {
            let result = future.await;
            let status = result
                .as_ref()
                .map(|response| response.status().as_u16())
                .unwrap_or(500);
            let attributes = [
                KeyValue::new("http.request.method", method),
                KeyValue::new("http.route", route),
                KeyValue::new("http.response.status_code", i64::from(status)),
            ];
            in_flight.finish();
            request_counter().add(1, &attributes);
            request_duration().record(started.elapsed().as_secs_f64(), &attributes);
            if status >= 500 || result.is_err() {
                request_errors().add(1, &attributes);
            }
            result
        })
    }
}

/// Creates a request-metrics middleware value for an Actix application.
pub fn http_metrics() -> TelemetryMetrics {
    TelemetryMetrics
}

const CORRELATION_ID_HEADER: HeaderName = HeaderName::from_static("x-correlation-id");

fn safe_correlation_id(request: &ServiceRequest) -> String {
    request
        .headers()
        .get(&CORRELATION_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| is_safe_correlation_id(value))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

/// Returns whether a correlation ID is safe to copy into logs and response/request headers.
pub fn is_safe_correlation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._:-".contains(character))
}

struct HeaderInjector<'a>(&'a mut http::HeaderMap);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        let Ok(name) = http::header::HeaderName::from_bytes(key.as_bytes()) else {
            return;
        };
        let Ok(value) = http::HeaderValue::from_str(&value) else {
            return;
        };
        self.0.insert(name, value);
    }
}

/// Injects the active W3C trace context into an outbound HTTP header map.
///
/// Application code remains responsible for authentication and correlation headers. This helper
/// only writes `traceparent`/`tracestate` through the configured OpenTelemetry propagator.
pub fn inject_trace_context(headers: &mut http::HeaderMap) {
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&Context::current(), &mut HeaderInjector(headers));
    });
}

/// Preserves a trusted, bounded application correlation ID across HTTP responses.
#[derive(Clone, Copy, Debug, Default)]
pub struct CorrelationId;

impl<S, B> Transform<S, ServiceRequest> for CorrelationId
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Transform = CorrelationIdService<S>;
    type InitError = ();
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(CorrelationIdService { service }))
    }
}

#[doc(hidden)]
pub struct CorrelationIdService<S> {
    service: S,
}

impl<S, B> Service<ServiceRequest> for CorrelationIdService<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: MessageBody + 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>>>>;

    actix_web::dev::forward_ready!(service);

    fn call(&self, mut request: ServiceRequest) -> Self::Future {
        let correlation_id = safe_correlation_id(&request);
        if let Ok(header) = HeaderValue::from_str(&correlation_id) {
            request
                .headers_mut()
                .insert(CORRELATION_ID_HEADER.clone(), header);
        }
        let future = self.service.call(request);

        Box::pin(async move {
            let mut response = future.await?;
            if let Ok(header) = HeaderValue::from_str(&correlation_id) {
                response.headers_mut().insert(CORRELATION_ID_HEADER, header);
            }
            Ok(response)
        })
    }
}

/// Creates the correlation-ID middleware for an Actix application.
pub fn correlation_id() -> CorrelationId {
    CorrelationId
}

/// Runs a long-lived background operation in a named trace span.
pub async fn in_span<F, T>(kind: &'static str, name: &'static str, future: F) -> T
where
    F: Future<Output = T>,
{
    use tracing::Instrument;
    let started = Instant::now();
    let attributes = operation_attributes(kind, name);
    let mut in_flight = InFlightGuard::new(operation_in_flight(), attributes);
    let result = future
        .instrument(tracing::info_span!(
            "kasitek.background",
            operation.kind = kind,
            operation.name = name
        ))
        .await;
    in_flight.finish();
    record_operation(kind, name, "success", started.elapsed());
    result
}

/// Runs an outbound dependency operation in a bounded provider span.
pub async fn provider_span<F, T>(provider: &'static str, operation: &'static str, future: F) -> T
where
    F: Future<Output = T>,
{
    use tracing::Instrument;
    let started = Instant::now();
    let attributes = operation_attributes("dependency", operation);
    let mut in_flight = InFlightGuard::new(operation_in_flight(), attributes);
    let result = future
        .instrument(tracing::info_span!(
            "kasitek.provider",
            peer.service = provider,
            kasitek.provider.operation = operation,
        ))
        .await;
    in_flight.finish();
    record_operation("dependency", operation, "success", started.elapsed());
    result
}

/// Records a retry without requiring callers to create a separate span for every backoff.
pub fn record_retry(kind: &'static str, name: &'static str, count: u64) {
    if count == 0 {
        return;
    }
    let attributes = operation_attributes(kind, name);
    operation_retries().add(count, &attributes);
}

/// Records the age of work at the point it is claimed from an asynchronous queue.
pub fn record_queue_age(queue: &'static str, age: Duration) {
    queue_age().record(
        age.as_secs_f64().max(0.0),
        &[KeyValue::new("queue.name", queue)],
    );
}

/// Records a dependency failure without copying provider response text into telemetry.
pub fn record_dependency_failure(provider: &'static str, operation: &'static str) {
    dependency_failures().add(
        1,
        &[
            KeyValue::new("peer.service", provider),
            KeyValue::new("operation.name", operation),
        ],
    );
}

/// Runs a fallible background operation and records success or failure on its span without
/// copying the error text into telemetry. Callers remain responsible for logging a safe error
/// code or message at the application boundary.
pub async fn result_span<F, T, E>(kind: &'static str, name: &'static str, future: F) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    use tracing::{field, Instrument};
    let started = Instant::now();
    let attributes = operation_attributes(kind, name);
    let mut in_flight = InFlightGuard::new(operation_in_flight(), attributes);
    let span = tracing::info_span!(
        "kasitek.background",
        operation.kind = kind,
        operation.name = name,
        otel.status_code = field::Empty,
        exception.type = field::Empty,
    );
    let result_span = span.clone();
    let result = async move {
        match future.await {
            Ok(value) => {
                result_span.record("otel.status_code", "OK");
                Ok(value)
            }
            Err(error) => {
                result_span.record("otel.status_code", "ERROR");
                result_span.record("exception.type", std::any::type_name::<E>());
                Err(error)
            }
        }
    }
    .instrument(span)
    .await;
    in_flight.finish();
    record_operation(
        kind,
        name,
        if result.is_ok() { "success" } else { "error" },
        started.elapsed(),
    );
    result
}

/// Fallible variant of [`provider_span`] that marks dependency errors on the span while keeping
/// error payloads out of telemetry attributes.
pub async fn provider_result_span<F, T, E>(
    provider: &'static str,
    operation: &'static str,
    future: F,
) -> Result<T, E>
where
    F: Future<Output = Result<T, E>>,
{
    provider_result_span_with(provider, operation, move || future).await
}

/// Fallible provider span variant that constructs its operation after the span is active.
///
/// Use this form when the operation needs to inject the active trace context into an outbound
/// request. Constructing the request inside the callback makes the downstream request a child of
/// the provider span rather than a sibling of it.
pub async fn provider_result_span_with<F, Fut, T, E>(
    provider: &'static str,
    operation: &'static str,
    operation_factory: F,
) -> Result<T, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    use tracing::{field, Instrument};
    let started = Instant::now();
    let attributes = operation_attributes("dependency", operation);
    let mut in_flight = InFlightGuard::new(operation_in_flight(), attributes);
    let span = tracing::info_span!(
        "kasitek.provider",
        peer.service = provider,
        kasitek.provider.operation = operation,
        otel.status_code = field::Empty,
        exception.type = field::Empty,
    );
    let result_span = span.clone();
    let result = async move {
        match operation_factory().await {
            Ok(value) => {
                result_span.record("otel.status_code", "OK");
                Ok(value)
            }
            Err(error) => {
                result_span.record("otel.status_code", "ERROR");
                result_span.record("exception.type", std::any::type_name::<E>());
                record_dependency_failure(provider, operation);
                Err(error)
            }
        }
    }
    .instrument(span)
    .await;
    in_flight.finish();
    record_operation(
        "dependency",
        operation,
        if result.is_ok() { "success" } else { "error" },
        started.elapsed(),
    );
    result
}

/// Initializes the shared Rust logging and telemetry stack for a named process.
pub fn init_with_service(default_filter: &str, service_name: &str) {
    if otel_export_configured() {
        if let Err(error) = init_otel(default_filter, service_name) {
            let diagnostic = redact_telemetry_text(error, 512);
            eprintln!(
                "OpenTelemetry initialization failed; continuing with stdout logging: {diagnostic}"
            );
            init_legacy(default_filter);
        }
    } else {
        init_legacy(default_filter);
    }
}

/// Initializes the shared Rust stack using `KASITEK_SERVICE_NAME` when supplied.
pub fn init(default_filter: &str) {
    let service_name =
        env::var("KASITEK_SERVICE_NAME").unwrap_or_else(|_| "kasitek-rust".to_string());
    init_with_service(default_filter, &service_name);
}

/// Flushes bounded telemetry queues during orderly process shutdown.
pub fn shutdown() {
    let timeout = Duration::from_secs(3);
    if let Some(providers) = PROVIDERS.get() {
        let tracer = providers.tracer;
        let meter = providers.meter;
        let logger = providers.logger;
        let (finished, wait) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = tracer.shutdown_with_timeout(timeout);
            let _ = meter.shutdown_with_timeout(timeout);
            let _ = logger.shutdown_with_timeout(timeout);
            let _ = finished.send(());
        });
        if wait.recv_timeout(timeout).is_err() {
            eprintln!(
                "OpenTelemetry shutdown exceeded the {} second limit",
                timeout.as_secs()
            );
        }
    }
}

/// Flushes telemetry when a service entrypoint returns or unwinds.
pub struct ShutdownGuard;

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        shutdown();
    }
}

fn init_legacy(default_filter: &str) {
    let mut builder = Builder::from_env(Env::default().default_filter_or(default_filter));
    builder.target(Target::Stdout);
    let colorize = request_log_colors_enabled();

    if structured_logs_enabled() {
        builder.write_style(WriteStyle::Never);
        builder.format(|buffer, record| {
            let event = json!({
                "timestamp": buffer.timestamp_millis().to_string(),
                "level": display_level(record).as_str().to_ascii_lowercase(),
                "target": record.target(),
                "message": record.args().to_string(),
            });

            writeln!(buffer, "{event}")
        });
    } else {
        builder.write_style(if colorize {
            WriteStyle::Always
        } else {
            WriteStyle::Never
        });
        builder.format(move |buffer, record| {
            let level = display_level(record);
            writeln!(
                buffer,
                "[{} {} {}] {}",
                buffer.timestamp(),
                format_level(level, colorize),
                record.target(),
                record.args(),
            )
        });
    }

    // Keep the existing `log!` output format while also providing a stdout fallback for the
    // `tracing!` calls used by the instrumented paths. The two globals are intentionally separate
    // when OTEL is disabled: legacy log records stay on env_logger, while tracing records use the
    // subscriber below. When OTEL initialization fails after installing LogTracer, env_logger's
    // `try_init` simply reports that the logger is already owned and the subscriber still receives
    // the bridged records. Both sinks receive the redacted compatibility record.
    let logger = builder.build();
    let max_level = logger.filter();
    if log::set_boxed_logger(Box::new(RedactingLogger { inner: logger })).is_ok() {
        log::set_max_level(max_level);
    }

    let tracing_result = if structured_logs_enabled() {
        let subscriber = tracing_subscriber::registry()
            .with(tracing_filter(default_filter))
            .with(
                tracing_subscriber::fmt::layer()
                    .json()
                    .with_target(true)
                    .with_current_span(true)
                    .with_span_list(false),
            );
        tracing::subscriber::set_global_default(subscriber)
    } else {
        let subscriber = tracing_subscriber::registry()
            .with(tracing_filter(default_filter))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_target(true)
                    .with_ansi(colorize),
            );
        tracing::subscriber::set_global_default(subscriber)
    };

    if let Err(error) = tracing_result {
        let diagnostic = redact_telemetry_text(error.to_string(), 512);
        eprintln!("legacy tracing subscriber initialization failed: {diagnostic}");
    }
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::{
        access_log_status, display_level, format_status, inject_trace_context,
        is_safe_correlation_id, parse_status_token, redact_telemetry_text, status_color, Sampler,
    };
    use log::{Level, Record};
    use opentelemetry::{
        global,
        trace::{
            Span as _, SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
            Tracer as _, TracerProvider as _,
        },
        Context,
    };
    use opentelemetry_sdk::trace::SdkTracerProvider;
    use tracing_subscriber::prelude::*;

    #[test]
    fn status_colors_follow_http_outcome_classes() {
        assert_eq!(status_color(200), "32");
        assert_eq!(status_color(302), "36");
        assert_eq!(status_color(404), "33");
        assert_eq!(status_color(503), "31");
    }

    #[test]
    fn status_format_can_be_kept_plain_for_structured_logs() {
        assert_eq!(format_status(503, false), "503");
    }

    #[test]
    fn status_format_wraps_terminal_status_in_ansi_color() {
        assert_eq!(format_status(200, true), "\u{1b}[32m200\u{1b}[0m");
    }

    #[test]
    fn request_status_maps_to_a_useful_display_level() {
        let record = Record::builder()
            .args(format_args!("503 70 0.1"))
            .level(Level::Info)
            .target("actix_web::middleware::logger")
            .build();
        assert_eq!(access_log_status(&record), Some(503));
        assert_eq!(display_level(&record), Level::Error);
    }

    #[test]
    fn request_status_mapping_handles_the_colorized_status_token() {
        assert_eq!(parse_status_token("\u{1b}[33m404\u{1b}[0m"), Some(404));
        let record = Record::builder()
            .args(format_args!("\u{1b}[33m404\u{1b}[0m 0.1"))
            .level(Level::Info)
            .target("actix_web::middleware::logger")
            .build();
        assert_eq!(display_level(&record), Level::Warn);
    }

    #[test]
    fn non_request_log_levels_are_unchanged() {
        let record = Record::builder()
            .args(format_args!("database unavailable"))
            .level(Level::Error)
            .target("kasitek_core::database")
            .build();
        assert_eq!(display_level(&record), Level::Error);
    }

    #[test]
    fn correlation_ids_are_bounded_and_header_safe() {
        assert!(is_safe_correlation_id("run-123:attempt_1"));
        assert!(!is_safe_correlation_id(""));
        assert!(!is_safe_correlation_id("bad value"));
        assert!(!is_safe_correlation_id(&"x".repeat(129)));
    }

    #[test]
    fn legacy_log_text_is_bounded_and_redacts_credentials() {
        let redacted = redact_telemetry_text(
            "request failed authorization=Bearer abc123&token=secret",
            512,
        );
        assert_eq!(
            redacted,
            "request failed authorization=[REDACTED]&token=[REDACTED]"
        );
        assert!(!redact_telemetry_text("Bearer abc123", 512).contains("abc123"));
        assert_eq!(redact_telemetry_text("x".repeat(200), 128).len(), 128);
    }

    #[test]
    fn injects_the_active_w3c_trace_context_into_http_headers() {
        global::set_text_map_propagator(super::TraceContextPropagator::new());
        let parent = SpanContext::new(
            TraceId::from_bytes([
                0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
                0xee, 0xff,
            ]),
            SpanId::from_bytes([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]),
            TraceFlags::SAMPLED,
            true,
            TraceState::from_key_value([("vendor", "value")]).expect("valid trace state"),
        );
        let _guard = Context::new().with_remote_span_context(parent).attach();
        let mut headers = http::HeaderMap::new();

        inject_trace_context(&mut headers);

        assert_eq!(
            headers
                .get("traceparent")
                .and_then(|value| value.to_str().ok()),
            Some("00-00112233445566778899aabbccddeeff-0123456789abcdef-01")
        );
        assert_eq!(
            headers
                .get("tracestate")
                .and_then(|value| value.to_str().ok()),
            Some("vendor=value")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn provider_factory_injects_the_provider_span_context() {
        global::set_text_map_propagator(super::TraceContextPropagator::new());
        let provider = SdkTracerProvider::builder().build();
        let tracer = provider.tracer("kasitek-test");
        let parent = tracer.start("parent");
        let parent_span_id = parent.span_context().span_id();
        let _parent_guard = Context::current_with_span(parent).attach();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(tracer.clone()));
        let _subscriber_guard = tracing::subscriber::set_default(subscriber);

        let (headers, active_trace_id, active_span_id) =
            super::provider_result_span_with("test-provider", "request", || async {
                let mut headers = http::HeaderMap::new();
                let active_span_context = Context::current().span().span_context().clone();
                super::inject_trace_context(&mut headers);
                Ok::<_, ()>((
                    headers,
                    active_span_context.trace_id(),
                    active_span_context.span_id(),
                ))
            })
            .await
            .expect("provider operation should succeed");

        assert_ne!(active_span_id, parent_span_id);
        let expected_traceparent = format!("00-{active_trace_id}-{active_span_id}-01");
        assert_eq!(
            headers
                .get("traceparent")
                .and_then(|value| value.to_str().ok()),
            Some(expected_traceparent.as_str())
        );
    }

    #[test]
    fn resource_contains_service_and_process_identity() {
        let resource = super::telemetry_resource("kasitek-test");
        assert!(resource
            .iter()
            .any(|(key, value)| key.as_str() == "service.name"
                && value.to_string() == "kasitek-test"));
        assert!(resource
            .iter()
            .any(|(key, _)| key.as_str() == "process.runtime.name"));
        assert!(resource
            .iter()
            .any(|(key, _)| key.as_str() == "process.pid"));
    }

    #[test]
    fn default_sampling_is_parent_based_when_not_overridden() {
        if env::var("OTEL_TRACES_SAMPLER").is_err() {
            assert!(matches!(
                super::sampler_from_environment(),
                Sampler::ParentBased(_)
            ));
        }
    }
}
