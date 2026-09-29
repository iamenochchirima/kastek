use kasitek_analytics::{error::AnalyticsError, registry};

fn main() -> Result<(), AnalyticsError> {
    let write = std::env::args()
        .skip(1)
        .any(|argument| argument == "--write");
    let check = std::env::args()
        .skip(1)
        .any(|argument| argument == "--check");
    if write && check {
        eprintln!("Choose only one of --write or --check");
        std::process::exit(2);
    }

    let snapshot = registry::load_registry()?;
    if write {
        snapshot.write_generated_bindings()?;
        println!("Generated Rust analytics registry bindings: {snapshot}");
    } else {
        snapshot.check_generated_bindings()?;
        println!("Validated Rust analytics registry bindings: {snapshot}");
    }
    Ok(())
}
