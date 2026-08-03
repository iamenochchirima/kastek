use std::{env, io::Write};

use env_logger::{Builder, Env, Target, WriteStyle};

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

pub fn init(default_filter: &str) {
    let mut builder = Builder::from_env(Env::default().default_filter_or(default_filter));
    builder.target(Target::Stdout);

    if structured_logs_enabled() {
        builder.write_style(WriteStyle::Never);
        builder.format(|buffer, record| {
            let event = serde_json::json!({
                "timestamp": buffer.timestamp_millis().to_string(),
                "level": record.level().as_str().to_ascii_lowercase(),
                "target": record.target(),
                "message": record.args().to_string(),
            });

            writeln!(buffer, "{event}")
        });
    }

    builder.init();
}
