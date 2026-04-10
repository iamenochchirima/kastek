use bcrypt::{hash, DEFAULT_COST};
use chrono::Utc;
use config::TenantServerConfig;
use dotenv::dotenv;
use sqlx::postgres::PgPoolOptions;
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
    workspace_name: String,
    admin_email: String,
    admin_password: String,
    admin_name: Option<String>,
    domain: Option<String>,
    primary_color: Option<String>,
    secondary_color: Option<String>,
    logo_url: Option<String>,
    api_key_label: String,
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

    let mut required = |name: &str| {
        values
            .remove(name)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CliError(format!("missing required argument --{name}")))
    };

    let optional = |name: &str, values: &mut HashMap<String, String>| {
        values
            .remove(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    Ok(Args {
        workspace_slug: required("workspace-slug")?.trim().to_ascii_lowercase(),
        workspace_name: required("workspace-name")?.trim().to_string(),
        admin_email: required("admin-email")?.trim().to_ascii_lowercase(),
        admin_password: required("admin-password")?.trim().to_string(),
        admin_name: optional("admin-name", &mut values),
        domain: optional("domain", &mut values).map(|value| value.to_ascii_lowercase()),
        primary_color: optional("primary-color", &mut values),
        secondary_color: optional("secondary-color", &mut values),
        logo_url: optional("logo-url", &mut values),
        api_key_label: optional("api-key-label", &mut values)
            .unwrap_or_else(|| "initial-provisioning-key".to_string()),
    })
}

fn usage() -> &'static str {
    "Usage:
  cargo run -p kasitek-tenants --bin bootstrap_tenant -- \
    --workspace-slug acme \
    --workspace-name \"Acme Agency\" \
    --admin-email owner@acme.com \
    --admin-password \"strong-password\" \
    [--admin-name \"Acme Owner\"] \
    [--domain portal.acme.com] \
    [--primary-color \"#0f172a\"] \
    [--secondary-color \"#334155\"] \
    [--logo-url \"https://...\"] \
    [--api-key-label \"initial-key\"]"
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

    sqlx::migrate!("./migrations").run(&pool).await?;

    let slug_exists = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM workspaces
        WHERE slug = $1
        LIMIT 1
        "#,
    )
    .bind(&args.workspace_slug)
    .fetch_optional(&pool)
    .await?;

    if slug_exists.is_some() {
        return Err(CliError(format!(
            "workspace slug already exists: {}",
            args.workspace_slug
        ))
        .into());
    }

    if let Some(domain) = &args.domain {
        let domain_exists = sqlx::query_scalar::<_, String>(
            r#"
            SELECT id
            FROM workspace_domains
            WHERE lower(domain) = lower($1)
            LIMIT 1
            "#,
        )
        .bind(domain)
        .fetch_optional(&pool)
        .await?;

        if domain_exists.is_some() {
            return Err(CliError(format!("workspace domain already exists: {domain}")).into());
        }
    }

    let workspace_id = cuid2::create_id();
    let tenant_user_id = cuid2::create_id();
    let api_key_id = cuid2::create_id();
    let domain_id = cuid2::create_id();
    let admin_password_hash = hash(&args.admin_password, DEFAULT_COST)?;
    let api_key_plain = format!("ktnt_{}", crypto_utils::generate_token(32));
    let api_key_prefix = api_key_plain.chars().take(12).collect::<String>();
    let api_key_hash = crypto_utils::sha256_hex(&api_key_plain);
    let scopes = serde_json::json!([
        "workspace:read",
        "workspace:write",
        "clients:read",
        "clients:write",
        "portal:bootstrap"
    ]);

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO workspaces (id, slug, display_name, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', NOW(), NOW())
        "#,
    )
    .bind(&workspace_id)
    .bind(&args.workspace_slug)
    .bind(&args.workspace_name)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO workspace_branding (
            workspace_id,
            display_name,
            primary_color,
            secondary_color,
            logo_url,
            custom_domain,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        "#,
    )
    .bind(&workspace_id)
    .bind(&args.workspace_name)
    .bind(&args.primary_color)
    .bind(&args.secondary_color)
    .bind(&args.logo_url)
    .bind(&args.domain)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO workspace_usage_limits (
            workspace_id,
            requests_per_month,
            tokens_per_month,
            conversations_per_month,
            created_at,
            updated_at
        )
        VALUES ($1, 0, 0, 0, NOW(), NOW())
        "#,
    )
    .bind(&workspace_id)
    .execute(&mut *tx)
    .await?;

    if let Some(domain) = &args.domain {
        sqlx::query(
            r#"
            INSERT INTO workspace_domains (
                id,
                workspace_id,
                domain,
                is_primary,
                verified_at,
                dns_status,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, TRUE, NOW(), 'verified', NOW(), NOW())
            "#,
        )
        .bind(&domain_id)
        .bind(&workspace_id)
        .bind(domain)
        .execute(&mut *tx)
        .await?;
    }

    sqlx::query(
        r#"
        INSERT INTO tenant_users (
            id,
            workspace_id,
            email,
            password_hash,
            name,
            status,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
        "#,
    )
    .bind(&tenant_user_id)
    .bind(&workspace_id)
    .bind(&args.admin_email)
    .bind(&admin_password_hash)
    .bind(&args.admin_name)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_user_roles (tenant_user_id, role, created_at)
        VALUES ($1, 'owner', NOW())
        "#,
    )
    .bind(&tenant_user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO workspace_api_keys (
            id,
            workspace_id,
            label,
            key_prefix,
            key_hash,
            scopes,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        "#,
    )
    .bind(&api_key_id)
    .bind(&workspace_id)
    .bind(&args.api_key_label)
    .bind(&api_key_prefix)
    .bind(&api_key_hash)
    .bind(scopes)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    println!("Tenant bootstrap completed at {}", Utc::now().to_rfc3339());
    println!("workspace_id={workspace_id}");
    println!("workspace_slug={}", args.workspace_slug);
    println!("workspace_name={}", args.workspace_name);
    if let Some(domain) = args.domain {
        println!("workspace_domain={domain}");
    }
    println!("tenant_admin_user_id={tenant_user_id}");
    println!("tenant_admin_email={}", args.admin_email);
    println!("api_key_id={api_key_id}");
    println!("api_key={api_key_plain}");

    Ok(())
}
