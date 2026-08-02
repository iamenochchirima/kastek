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

## Temporary release access mode

KasiTek starts in invitation-only mode. Set `KASITEK_ACCESS_MODE=private` (or leave it unset) while access is controlled: public signup is blocked, but activated users continue to sign in normally and invitation links can create their accounts.

When the release is ready for public registration, set `KASITEK_ACCESS_MODE=public` on the core backend and `NEXT_PUBLIC_KASITEK_ACCESS_MODE=public` on the client app, then redeploy both services. Existing invitations and normal login continue to work in either mode.

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
KASITEK_PROCESS=billing-reconciliation-worker cargo run
KASITEK_PROCESS=all-workers cargo run
```

Server runs on `http://localhost:8080` by default unless `PORT` is set.
