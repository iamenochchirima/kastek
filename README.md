# kasitek

## Local Stack

The KasiTek stack uses one root vault-backed `.env` as the merged source of
truth:

- root `.env` and `.env.vault`
- local source files merged into the root vault on push:
  - `.env.local`
  - `server/kasitek-core/.env`
  - `server/kasitek-tenants/.env`
  - `client/.env.local`
  - `client/apps/tenant-portal/.env`
  - `client/apps/tenant-portal/.env.local`
- generated copies restored on pull:
  - `.env.local`
  - `server/kasitek-core/.env`
  - `server/kasitek-tenants/.env`
  - `client/.env`
  - `client/.env.local`
  - `client/apps/tenant-portal/.env`
  - `client/apps/tenant-portal/.env.local`

Use these commands to keep the vault in sync:

```bash
./scripts/sync_dotenv_vaults.sh login
./scripts/sync_dotenv_vaults.sh pull
./scripts/sync_dotenv_vaults.sh push
./scripts/sync_dotenv_vaults.sh status
```

The `login` step is the one-time vault bootstrap for the repo root. After
that, `push` merges the local env files into the root vault-backed `.env`, and
`pull` restores the same merged env into the local service files. The actual
secret values stay in dotenv-vault, not in plain git-tracked files.

Run these in separate terminals:

```bash
# Core API with automatic restart on Rust or server/kasitek-core/.env changes
./scripts/dev_core_watch.sh
```

The watcher reloads environment variables whenever it restarts. Edit
`server/kasitek-core/.env`, then save it; the API will restart with the new values.
Changes to the root vault-backed env should be restored to the service env first with
`./scripts/sync_dotenv_vaults.sh pull`.

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/server/kasitek-tenants
cargo run
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/server/kasitek-core
cargo run
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm run dev
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm dev:admin
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm --filter tenant-portal dev
```

The public development API origin is `https://dev-client.kasitek.co.za`; no
local tunnel is required for provider webhooks.
