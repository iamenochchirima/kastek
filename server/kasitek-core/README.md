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

By default, the API server also starts the WhatsApp inbox, WhatsApp marketing, and social publishing workers in the same process.

If you need to disable embedded workers for a pure API process, set:

```bash
KASITEK_DISABLE_BACKGROUND_WORKERS=true cargo run
```

If you want a dedicated worker-only process, use:

```bash
KASITEK_PROCESS=whatsapp-marketing-worker cargo run
KASITEK_PROCESS=whatsapp-inbox-worker cargo run
KASITEK_PROCESS=social-publishing-worker cargo run
KASITEK_PROCESS=all-workers cargo run
```

Server runs on `http://localhost:8080` by default unless `PORT` is set.
