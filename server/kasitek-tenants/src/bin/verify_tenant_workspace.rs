use config::TenantServerConfig;
use dotenv::dotenv;
use sqlx::{postgres::PgPoolOptions, FromRow};
use std::{collections::HashMap, error::Error, fmt};

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Error for CliError {}

#[derive(Debug)]
struct Args {
    workspace_slug: String,
    expect_domain: Option<String>,
}

#[derive(Debug, FromRow)]
struct VerificationRow {
    workspace_id: String,
    display_name: String,
    status: String,
    domain_count: i64,
    tenant_admin_count: i64,
    tenant_client_count: i64,
    client_user_count: i64,
    lead_count: i64,
    conversation_count: i64,
    api_key_count: i64,
}

fn parse_args() -> Result<Args, CliError> {
    let mut values = HashMap::new();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        if let Some(name) = arg.strip_prefix("--") {
            let value = args
                .next()
                .ok_or_else(|| CliError(format!("missing value for --{name}")))?;
            values.insert(name.to_string(), value);
        } else {
            return Err(CliError(format!("unexpected argument: {arg}")));
        }
    }

    let workspace_slug = values
        .remove("workspace-slug")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CliError("missing required argument --workspace-slug".to_string()))?;

    let expect_domain = values
        .remove("expect-domain")
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    Ok(Args {
        workspace_slug,
        expect_domain,
    })
}

fn usage() -> &'static str {
    "Usage:
  cargo run -p kasitek-tenants --bin verify_tenant_workspace -- \
    --workspace-slug acme \
    [--expect-domain portal.acme.local]"
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    dotenv().ok();

    let args = parse_args().map_err(|err| {
        eprintln!("{err}\n\n{}", usage());
        err
    })?;

    let config = TenantServerConfig::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&config.database_url)
        .await?;

    let row = sqlx::query_as::<_, VerificationRow>(
        r#"
        SELECT
            w.id AS workspace_id,
            w.display_name,
            w.status,
            (SELECT COUNT(*) FROM workspace_domains d WHERE d.workspace_id = w.id) AS domain_count,
            (
                SELECT COUNT(*)
                FROM tenant_users u
                JOIN tenant_user_roles r ON r.tenant_user_id = u.id
                WHERE u.workspace_id = w.id
                  AND r.role = 'owner'
            ) AS tenant_admin_count,
            (SELECT COUNT(*) FROM tenant_clients c WHERE c.workspace_id = w.id) AS tenant_client_count,
            (SELECT COUNT(*) FROM tenant_client_users cu WHERE cu.workspace_id = w.id) AS client_user_count,
            (SELECT COUNT(*) FROM tenant_leads l WHERE l.workspace_id = w.id) AS lead_count,
            (SELECT COUNT(*) FROM conversations c WHERE c.workspace_id = w.id) AS conversation_count,
            (SELECT COUNT(*) FROM workspace_api_keys k WHERE k.workspace_id = w.id) AS api_key_count
        FROM workspaces w
        WHERE w.slug = $1
        LIMIT 1
        "#,
    )
    .bind(&args.workspace_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| CliError(format!("workspace not found: {}", args.workspace_slug)))?;

    if let Some(expected_domain) = &args.expect_domain {
        let exists = sqlx::query_scalar::<_, String>(
            r#"
            SELECT domain
            FROM workspace_domains
            WHERE workspace_id = $1
              AND lower(domain) = lower($2)
            LIMIT 1
            "#,
        )
        .bind(&row.workspace_id)
        .bind(expected_domain)
        .fetch_optional(&pool)
        .await?;

        if exists.is_none() {
            return Err(CliError(format!(
                "expected domain not found for workspace {}: {}",
                args.workspace_slug, expected_domain
            ))
            .into());
        }
    }

    println!("Tenant verification summary");
    println!("workspace_slug={}", args.workspace_slug);
    println!("workspace_id={}", row.workspace_id);
    println!("display_name={}", row.display_name);
    println!("status={}", row.status);
    println!("domain_count={}", row.domain_count);
    println!("tenant_admin_count={}", row.tenant_admin_count);
    println!("tenant_client_count={}", row.tenant_client_count);
    println!("client_user_count={}", row.client_user_count);
    println!("lead_count={}", row.lead_count);
    println!("conversation_count={}", row.conversation_count);
    println!("api_key_count={}", row.api_key_count);

    if row.status != "active" {
        return Err(CliError("workspace is not active".to_string()).into());
    }

    if row.tenant_admin_count == 0 {
        return Err(CliError("workspace has no owner/admin bootstrap user".to_string()).into());
    }

    if row.api_key_count == 0 {
        return Err(CliError("workspace has no API keys".to_string()).into());
    }

    Ok(())
}
