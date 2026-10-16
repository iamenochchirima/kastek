# @kasitek/mcp

Local stdio compatibility bridge for the KasiTek MCP gateway.

Use this package only when an MCP client requires a local command-launched server. Clients that
support remote Streamable HTTP can connect directly to the configured KasiTek `/mcp` endpoint and
do not need this package.

The bridge owns no business tools, capability policy, approvals, audit records, or product data. It
forwards JSON-RPC messages to KasiTek and keeps credentials out of stdout and error messages.

## Configuration

```bash
export KASITEK_MCP_URL="https://agents.kasitek.co.za/mcp"
export KASITEK_API_KEY="kst_..."
# After the package is published:
npx -y @kasitek/mcp
```

For local development:

```bash
export KASITEK_MCP_URL="http://127.0.0.1:4200/mcp"
export KASITEK_API_KEY="kst_..."
npx -y @kasitek/mcp
```

`MCP_STDIO_URL` and the old token variable names remain accepted as compatibility aliases for the
internal Agent Platform bridge. The same Developer API key works for REST and MCP; MCP clients
send it as a normal Bearer credential to the hosted endpoint. REST access is documented separately.
