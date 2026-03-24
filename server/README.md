# The Architect Server

Actix-web backend for thearchitect.fun.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Start Postgres and run migrations: `cargo sqlx migrate run`
3. Run server: `cargo run`

## Development

```bash
cargo run
```

Server runs on `http://localhost:8080` by default.
