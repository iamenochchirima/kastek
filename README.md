# kasitek

## Local Stack

The direct KasiTek stack uses local env files for the main services:

- `server/kasitek-core/.env`
- `server/kasitek-calls/.env`
- `client/apps/call-bridge/.env.local`
- `client/apps/client/.env.local`

The tracked source of truth lives in `local-envs/`.

Use these commands to keep everything in sync:

```bash
./scripts/sync_local_envs.sh pull
./scripts/sync_local_envs.sh push
./scripts/sync_local_envs.sh status
```

The tenant platform and admin client are not part of this local stack.

Run these in separate terminals:

```bash
livekit-server --dev --bind 0.0.0.0
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/server/kasitek-calls
cargo run
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/server/kasitek-core
cargo run
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm dev:call-bridge
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm --filter call-bridge provider:meta-livekit-relay
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm dev:call-bridge:worker:meta-relay
```

```bash
cd /home/enoch/aworkspace/apersonal/kasitek-workspace/kasitek/client
pnpm run dev
```

```bash
ngrok http 4000
```
