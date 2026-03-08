# MCP Gateway

This is the standalone HTTP gateway that lets World Monitor consume external MCP servers without trying to run stdio transports inside Vercel Edge.

## What it does

- Connects to MCP servers over `stdio`, `streamable-http`, or legacy `sse`
- Exposes a small authenticated HTTP API for World Monitor:
  - `GET /health`
  - `GET /v1/tools`
  - `POST /v1/tools/invoke`
- Caches live MCP client sessions and closes idle connections automatically

## Configuration

1. Copy `mcp-gateway/servers.example.json` to a real config file.
2. Set `MCP_GATEWAY_CONFIG` to that file path.
3. Set `MCP_GATEWAY_TOKEN` so World Monitor can authenticate to the gateway.
4. Point World Monitor at the gateway with:
   - `MCP_GATEWAY_URL`
   - `MCP_GATEWAY_TOKEN`
   - `MCP_ENABLED_TOOLS`
   - `MCP_TIMEOUT_MS`

## Run

```bash
npm run mcp:gateway
```
