use std::{
    env,
    io::{IsTerminal, Write},
};

use actix_web::{dev::ServiceResponse, middleware::Logger};
use env_logger::{Builder, Env, Target, WriteStyle};
use log::{Level, Record};

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
    let (_, response) = message.split_once("\" ")?;
    parse_status_token(response.split_whitespace().next()?)
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
/// The status code and displayed log level are colorized, keeping the access-log format stable
/// while making successful, redirect, client-error, and server-error responses easy to scan.
/// Structured logs and non-terminal output remain ANSI-free unless `LOG_COLOR=always` is set.
pub fn http_logger() -> Logger {
    let colorize = request_log_colors_enabled();
    Logger::new(r#"%a "%r" %{STATUS}xo %b "%{Referer}i" "%{User-Agent}i" %T"#)
        .custom_response_replace("STATUS", move |response: &ServiceResponse| {
            format_status(response.status().as_u16(), colorize)
        })
}

pub fn init(default_filter: &str) {
    let mut builder = Builder::from_env(Env::default().default_filter_or(default_filter));
    builder.target(Target::Stdout);
    let colorize = request_log_colors_enabled();

    if structured_logs_enabled() {
        builder.write_style(WriteStyle::Never);
        builder.format(|buffer, record| {
            let event = serde_json::json!({
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

    builder.init();
}

#[cfg(test)]
mod tests {
    use super::{
        access_log_status, display_level, format_status, parse_status_token, status_color,
    };
    use log::{Level, Record};

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
            .args(format_args!(
                "127.0.0.1 \"GET / HTTP/1.1\" 503 70 \"-\" \"node\" 0.1"
            ))
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
            .args(format_args!(
                "127.0.0.1 \"GET /missing HTTP/1.1\" \u{1b}[33m404\u{1b}[0m 0 \"-\" \"node\" 0.1"
            ))
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
}
