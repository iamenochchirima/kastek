use bcrypt::{hash, DEFAULT_COST};
use chrono::Utc;
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
    client_name: String,
    client_slug: String,
    client_user_email: String,
    client_user_password: String,
    client_user_name: Option<String>,
}

#[derive(Debug, FromRow)]
struct WorkspaceRow {
    id: String,
    display_name: String,
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
        client_name: required("client-name")?.trim().to_string(),
        client_slug: required("client-slug")?.trim().to_ascii_lowercase(),
        client_user_email: required("client-user-email")?.trim().to_ascii_lowercase(),
        client_user_password: required("client-user-password")?.trim().to_string(),
        client_user_name: optional("client-user-name", &mut values),
    })
}

fn usage() -> &'static str {
    "Usage:
  cargo run -p kasitek-tenants --bin seed_tenant_demo -- \
    --workspace-slug acme \
    --client-name \"Acme Dental\" \
    --client-slug acme-dental \
    --client-user-email owner@acmedental.com \
    --client-user-password \"change-this-password\" \
    [--client-user-name \"Acme Dental Owner\"]"
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

    let workspace = sqlx::query_as::<_, WorkspaceRow>(
        r#"
        SELECT id, display_name
        FROM workspaces
        WHERE slug = $1
        LIMIT 1
        "#,
    )
    .bind(&args.workspace_slug)
    .fetch_optional(&pool)
    .await?
    .ok_or_else(|| CliError(format!("workspace not found: {}", args.workspace_slug)))?;

    let existing_client = sqlx::query_scalar::<_, String>(
        r#"
        SELECT id
        FROM tenant_clients
        WHERE workspace_id = $1 AND slug = $2
        LIMIT 1
        "#,
    )
    .bind(&workspace.id)
    .bind(&args.client_slug)
    .fetch_optional(&pool)
    .await?;

    if existing_client.is_some() {
        return Err(CliError(format!(
            "tenant client slug already exists for workspace {}: {}",
            args.workspace_slug, args.client_slug
        ))
        .into());
    }

    let client_id = cuid2::create_id();
    let client_user_id = cuid2::create_id();
    let client_user_password_hash = hash(&args.client_user_password, DEFAULT_COST)?;

    let mut tx = pool.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_clients (
            id,
            workspace_id,
            name,
            slug,
            status,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
        "#,
    )
    .bind(&client_id)
    .bind(&workspace.id)
    .bind(&args.client_name)
    .bind(&args.client_slug)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_client_users (
            id,
            workspace_id,
            tenant_client_id,
            email,
            password_hash,
            name,
            status,
            last_login_at,
            created_at,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW(), NOW())
        "#,
    )
    .bind(&client_user_id)
    .bind(&workspace.id)
    .bind(&client_id)
    .bind(&args.client_user_email)
    .bind(&client_user_password_hash)
    .bind(&args.client_user_name)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO tenant_client_user_roles (tenant_client_user_id, role, created_at)
        VALUES ($1, 'owner', NOW())
        "#,
    )
    .bind(&client_user_id)
    .execute(&mut *tx)
    .await?;

    for index in 0..2 {
        let agent_id = cuid2::create_id();
        let agent_name = if index == 0 {
            format!("{} Intake Agent", args.client_name)
        } else {
            format!("{} Follow-up Agent", args.client_name)
        };

        sqlx::query(
            r#"
            INSERT INTO workspace_agents (
                id,
                workspace_id,
                name,
                status,
                config,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
            "#,
        )
        .bind(&agent_id)
        .bind(&workspace.id)
        .bind(agent_name)
        .bind(serde_json::json!({
            "seeded": true,
            "clientSlug": args.client_slug,
            "variant": index,
        }))
        .execute(&mut *tx)
        .await?;
    }

    for (event_type, quantity) in [("request", 124_i64), ("token", 8740_i64), ("conversation", 6_i64)] {
        let event_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO workspace_usage_events (
                id,
                workspace_id,
                event_type,
                provider,
                quantity,
                metadata,
                created_at
            )
            VALUES ($1, $2, $3, 'seed', $4, $5, NOW())
            "#,
        )
        .bind(&event_id)
        .bind(&workspace.id)
        .bind(event_type)
        .bind(quantity)
        .bind(serde_json::json!({
            "seeded": true,
            "clientSlug": args.client_slug,
        }))
        .execute(&mut *tx)
        .await?;
    }

    for index in 0..4 {
        let lead_id = cuid2::create_id();
        let lead_name = format!("Prospect {}", index + 1);
        let lead_email = format!("prospect{}@{}.demo", index + 1, args.client_slug);
        let source = match index {
            0 => "web_chat",
            1 => "whatsapp",
            2 => "voice",
            _ => "manual",
        };
        let status = match index {
            0 => "new",
            1 => "qualified",
            2 => "contacted",
            _ => "converted",
        };
        let score = 55 + (index * 10);

        sqlx::query(
            r#"
            INSERT INTO tenant_leads (
                id,
                workspace_id,
                tenant_client_id,
                created_by_client_user_id,
                name,
                email,
                phone,
                company,
                source,
                status,
                score,
                notes,
                metadata,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
            "#,
        )
        .bind(&lead_id)
        .bind(&workspace.id)
        .bind(&client_id)
        .bind(&client_user_id)
        .bind(&lead_name)
        .bind(&lead_email)
        .bind(format!("+27 82 555 01{:02}", index))
        .bind(&args.client_name)
        .bind(source)
        .bind(status)
        .bind(score)
        .bind(format!("Seeded lead {lead_name} for {}", args.client_name))
        .bind(serde_json::json!({
            "seeded": true,
            "workspaceSlug": args.workspace_slug,
        }))
        .execute(&mut *tx)
        .await?;
    }

    for index in 0..3 {
        let conversation_id = cuid2::create_id();
        let customer_name = format!("{} Contact {}", args.client_name, index + 1);
        let customer_identifier = format!("{}-contact-{}", args.client_slug, index + 1);
        let channel = match index {
            0 => "whatsapp",
            1 => "web_chat",
            _ => "email",
        };
        let conversation_status = if index == 2 { "open" } else { "active" };

        sqlx::query(
            r#"
            INSERT INTO conversations (
                id,
                workspace_id,
                tenant_client_id,
                external_id,
                channel,
                customer_identifier,
                customer_name,
                status,
                metadata,
                last_message_at,
                created_at,
                updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
            "#,
        )
        .bind(&conversation_id)
        .bind(&workspace.id)
        .bind(&client_id)
        .bind(format!("seed-conversation-{}", index + 1))
        .bind(channel)
        .bind(&customer_identifier)
        .bind(&customer_name)
        .bind(conversation_status)
        .bind(serde_json::json!({
            "seeded": true,
            "clientSlug": args.client_slug,
        }))
        .execute(&mut *tx)
        .await?;

        let inbound_message_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO messages (
                id,
                conversation_id,
                workspace_id,
                sender_role,
                content,
                metadata,
                created_at
            )
            VALUES ($1, $2, $3, 'client', $4, $5, NOW())
            "#,
        )
        .bind(&inbound_message_id)
        .bind(&conversation_id)
        .bind(&workspace.id)
        .bind(format!("Hi, I want help with {} offer {}", args.client_name, index + 1))
        .bind(serde_json::json!({ "seeded": true }))
        .execute(&mut *tx)
        .await?;

        let reply_message_id = cuid2::create_id();
        sqlx::query(
            r#"
            INSERT INTO messages (
                id,
                conversation_id,
                workspace_id,
                sender_role,
                content,
                metadata,
                created_at
            )
            VALUES ($1, $2, $3, 'agent', $4, $5, NOW())
            "#,
        )
        .bind(&reply_message_id)
        .bind(&conversation_id)
        .bind(&workspace.id)
        .bind("Thanks, we have captured your request and the team will follow up shortly.")
        .bind(serde_json::json!({ "seeded": true }))
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    println!("Tenant demo seed completed at {}", Utc::now().to_rfc3339());
    println!("workspace_slug={}", args.workspace_slug);
    println!("workspace_name={}", workspace.display_name);
    println!("tenant_client_id={client_id}");
    println!("tenant_client_name={}", args.client_name);
    println!("tenant_client_slug={}", args.client_slug);
    println!("client_user_id={client_user_id}");
    println!("client_user_email={}", args.client_user_email);
    println!("client_user_password={}", args.client_user_password);
    if let Some(base_url) = config.app_base_url.as_ref() {
        println!("tenant_login_url={}/login", base_url.trim_end_matches('/'));
        println!("client_portal_url={}/client", base_url.trim_end_matches('/'));
    }
    println!("seeded_agents=2");
    println!("seeded_leads=4");
    println!("seeded_conversations=3");
    println!("seeded_messages=6");

    Ok(())
}
